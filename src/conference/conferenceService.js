/**
 * Aura Conference Service
 * ============================================================================
 *
 * Purpose:
 * Owns the lifecycle of a Conference recording session: the session row, the
 * ordered audio chunks captured while a meeting is running, and cleanup.
 *
 * Recording is deliberately all this does. Transcription, topic extraction and
 * record generation run as separate steps after the meeting ends, so a live
 * call never competes with Whisper, Ollama or ComfyUI for the GPU.
 *
 * Owns:
 * - conferences / conference_chunks rows
 * - chunk files on disk under data/audio/conference
 *
 * Does NOT own:
 * - browser audio capture (public/index.html)
 * - transcription, LLM processing, image generation
 */

const fs = require('fs');
const path = require('path');

const db = require('../db/connection');
const paths = require('../config/paths');

/**
 * Sessions are usually started mid-meeting, when naming something is the last
 * thing on the user's mind. A dated fallback keeps the list readable without
 * forcing a decision up front; the title stays editable later.
 */
function buildDefaultTitle() {
    const now = new Date();

    const pad = (value) => String(value).padStart(2, '0');

    return [
        'Conference ',
        now.getFullYear(), '-', pad(now.getMonth() + 1), '-', pad(now.getDate()),
        ' ', pad(now.getHours()), ':', pad(now.getMinutes())
    ].join('');
}

/**
 * Creates a new recording session.
 *
 * @param {Object} params
 * @param {string} params.title Optional user-supplied session title.
 * @param {number|null} params.groupId Optional Library Group for the drafts
 *   this session will eventually produce.
 * @returns {Object} The created session.
 */
function createSession({ title, groupId = null }) {
    const cleanTitle =
        String(title || '').trim() || buildDefaultTitle();

    const result = db.prepare(`
        INSERT INTO conferences (
            title,
            status,
            group_id
        )
        VALUES (?, 'recording', ?)
    `).run(cleanTitle, groupId);

    return getSession(result.lastInsertRowid);
}

/**
 * Registers one uploaded audio chunk against a session.
 *
 * Chunks arrive while the meeting is still running, so this rejects anything
 * for a session that has already finished -- a late upload after finish would
 * otherwise land in a session whose duration was already totalled.
 *
 * @param {Object} params
 * @param {number} params.conferenceId
 * @param {number} params.chunkIndex Capture order, assigned by the recorder.
 * @param {string} params.audioPath Absolute path to the stored .webm.
 * @param {number|null} params.durationMs Measured by the browser while recording.
 * @returns {Object} The created chunk row.
 */
function addChunk({ conferenceId, chunkIndex, audioPath, durationMs = null }) {
    const session = getSessionRow(conferenceId);

    if (!session) {
        throw new Error(`Conference ${conferenceId} not found.`);
    }

    if (session.status !== 'recording') {
        throw new Error(
            `Conference ${conferenceId} is not recording (status: ${session.status}).`
        );
    }

    const result = db.prepare(`
        INSERT INTO conference_chunks (
            conference_id,
            chunk_index,
            audio_path,
            duration_ms
        )
        VALUES (?, ?, ?, ?)
    `).run(
        conferenceId,
        chunkIndex,
        audioPath,
        durationMs
    );

    return db.prepare(`
        SELECT * FROM conference_chunks WHERE id = ?
    `).get(result.lastInsertRowid);
}

/**
 * Closes a session once recording has stopped.
 *
 * Total duration is summed from the chunks rather than measured from wall
 * clock, so a dropped chunk is visible as a shorter session instead of
 * silently implying audio that was never stored.
 *
 * @param {number} conferenceId
 * @returns {Object} The finished session.
 */
function finishSession(conferenceId) {
    const session = getSessionRow(conferenceId);

    if (!session) {
        throw new Error(`Conference ${conferenceId} not found.`);
    }

    const totals = db.prepare(`
        SELECT
            COUNT(*) AS chunkCount,
            COALESCE(SUM(duration_ms), 0) AS durationMs
        FROM conference_chunks
        WHERE conference_id = ?
    `).get(conferenceId);

    db.prepare(`
        UPDATE conferences
        SET status = 'recorded',
            duration_ms = ?
        WHERE id = ?
    `).run(totals.durationMs, conferenceId);

    return getSession(conferenceId);
}

function getSessionRow(conferenceId) {
    return db.prepare(`
        SELECT * FROM conferences WHERE id = ?
    `).get(conferenceId);
}

/**
 * Returns one session with its chunks in capture order and its topics.
 *
 * source_text_json is parsed here so callers never deal with the raw column. A
 * malformed value degrades to null rather than throwing -- it is display data,
 * and losing it should not make the session unreadable.
 *
 * @param {number} conferenceId
 * @returns {Object|null}
 */
function getSession(conferenceId) {
    const session = getSessionRow(conferenceId);

    if (!session) {
        return null;
    }

    const chunks = db.prepare(`
        SELECT id, chunk_index, audio_path, duration_ms, created_at
        FROM conference_chunks
        WHERE conference_id = ?
        ORDER BY chunk_index
    `).all(conferenceId);

    let sourceText = null;

    if (session.source_text_json) {
        try {
            sourceText = JSON.parse(session.source_text_json);
        } catch (error) {
            console.warn(
                `[AURA CONFERENCE] Unreadable source_text_json on conference ${conferenceId}:`,
                error.message
            );
        }
    }

    return {
        ...session,
        sourceText,
        chunks,
        topics: listTopics(conferenceId)
    };
}

/**
 * Sets the session status, and the error message that goes with it.
 *
 * `error` is cleared on every transition that does not supply one, so a
 * message from a failed run cannot outlive the run and appear against a
 * later, successful one.
 */
function setStatus(conferenceId, status, error = null) {
    db.prepare(`
        UPDATE conferences
        SET status = ?, error = ?
        WHERE id = ?
    `).run(status, error, conferenceId);
}

function saveTranscript(conferenceId, transcript, language = null) {
    db.prepare(`
        UPDATE conferences
        SET transcript = ?,
            language = COALESCE(?, language)
        WHERE id = ?
    `).run(transcript, language, conferenceId);
}

/**
 * Replaces a conference's extraction output.
 *
 * Topics are deleted and rewritten rather than merged, so re-processing a
 * meeting produces the same result as processing it the first time. Written in
 * one transaction because a half-replaced topic list is worse than either the
 * old one or the new one.
 */
const saveExtraction = db.transaction((conferenceId, { sourceText, language, topics }) => {
    db.prepare(`
        UPDATE conferences
        SET source_text_json = ?,
            language = COALESCE(?, language)
        WHERE id = ?
    `).run(
        sourceText ? JSON.stringify(sourceText) : null,
        language,
        conferenceId
    );

    db.prepare('DELETE FROM conference_topics WHERE conference_id = ?')
        .run(conferenceId);

    const insert = db.prepare(`
        INSERT INTO conference_topics (
            conference_id, subject_id, order_index, title, description,
            visual_concept, image_strategy, positive_prompt, negative_prompt,
            search_query, alt_queries, original_trigger_text,
            cleaned_trigger_text, salience, confidence, is_sensitive, raw_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const topic of topics) {
        insert.run(
            conferenceId,
            topic.subjectId,
            topic.orderIndex,
            topic.title,
            topic.description,
            topic.visualConcept,
            topic.imageStrategy,
            topic.positivePrompt,
            topic.negativePrompt,
            topic.searchQuery,
            JSON.stringify(topic.altQueries || []),
            topic.triggerCandidateText,
            topic.cleanedTriggerText,
            topic.salience,
            topic.confidence,
            topic.isSensitive ? 1 : 0,
            JSON.stringify(topic.raw || {})
        );
    }
});

/**
 * Sets a topic's dispatch status.
 *
 * Like the session-level equivalent, `error` is cleared on any transition that
 * does not supply one, so a message from a failed attempt cannot survive into
 * a later successful retry.
 */
function setTopicStatus(topicId, status, error = null) {
    db.prepare(`
        UPDATE conference_topics
        SET status = ?, error = ?
        WHERE id = ?
    `).run(status, error, topicId);
}

function listTopics(conferenceId) {
    const rows = db.prepare(`
        SELECT * FROM conference_topics
        WHERE conference_id = ?
        ORDER BY order_index, id
    `).all(conferenceId);

    return rows.map(row => ({
        ...row,
        alt_queries: parseJsonColumn(row.alt_queries, [])
    }));
}

function parseJsonColumn(value, fallback) {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

/**
 * Fields the review screen may correct before anything is dispatched.
 *
 * Restricted to the four the user actually reviews. Letting the client patch
 * arbitrary columns would put status and foreign keys within reach of the
 * review form for no benefit.
 */
const EDITABLE_TOPIC_FIELDS = new Set([
    'title',
    'description',
    'positive_prompt',
    'search_query',
    'cleaned_trigger_text',
    'image_strategy',
    'is_approved'
]);

function updateTopic(topicId, patch = {}) {
    const assignments = [];
    const values = [];

    for (const [key, value] of Object.entries(patch)) {
        if (!EDITABLE_TOPIC_FIELDS.has(key)) {
            continue;
        }

        assignments.push(`${key} = ?`);

        values.push(
            key === 'is_approved'
                ? (value ? 1 : 0)
                : value
        );
    }

    if (assignments.length === 0) {
        throw new Error('No editable fields were supplied.');
    }

    values.push(topicId);

    const result = db.prepare(`
        UPDATE conference_topics
        SET ${assignments.join(', ')}
        WHERE id = ?
    `).run(...values);

    if (result.changes === 0) {
        throw new Error(`Conference topic ${topicId} not found.`);
    }

    return db.prepare('SELECT * FROM conference_topics WHERE id = ?').get(topicId);
}

/**
 * Returns conferences stuck in a transient status to 'recorded'.
 *
 * Called at startup: the job registry is in-process, so anything left in
 * transcribing/extracting by a restart has nothing working on it.
 */
function resetInFlightStatuses() {
    // 'generating' returns to 'review' rather than 'recorded': the transcript
    // and subjects are already there, and re-processing would discard edits
    // made on the review screen. Subjects that completed keep their records --
    // a resumed dispatch skips anything that already has one.
    const conferences = db.prepare(`
        UPDATE conferences
        SET status = CASE WHEN status = 'generating' THEN 'review' ELSE 'recorded' END,
            error = 'Processing was interrupted by a restart.'
        WHERE status IN ('transcribing', 'extracting', 'generating')
    `).run();

    const topics = db.prepare(`
        UPDATE conference_topics
        SET status = 'pending'
        WHERE status = 'generating'
    `).run();

    return conferences.changes + topics.changes;
}

/**
 * Lists recent sessions for the Conference view.
 *
 * @param {number} limit
 * @returns {Array}
 */
function listSessions(limit = 50) {
    // Counted with scalar subqueries rather than two JOINs: joining both child
    // tables multiplies their rows against each other, which would report
    // chunks x topics for every session that has both.
    return db.prepare(`
        SELECT
            c.*,
            (SELECT COUNT(*) FROM conference_chunks ch
              WHERE ch.conference_id = c.id) AS chunk_count,
            (SELECT COUNT(*) FROM conference_topics t
              WHERE t.conference_id = c.id) AS topic_count
        FROM conferences c
        ORDER BY c.id DESC
        LIMIT ?
    `).all(limit);
}

/**
 * Deletes a session and the audio it captured.
 *
 * Chunk rows cascade with the session; the files behind them do not, so they
 * are removed explicitly first. Each path is confirmed to sit inside Aura's
 * conference audio directory before anything is unlinked -- these values are
 * only ever written by Aura's own upload handler, but a delete loop driven by
 * stored paths should not be the one place that trusts them blindly.
 *
 * @param {number} conferenceId
 * @returns {{deletedFiles: number}}
 */
function deleteSession(conferenceId) {
    const session = getSession(conferenceId);

    if (!session) {
        throw new Error(`Conference ${conferenceId} not found.`);
    }

    const audioRoot = path.resolve(paths.conferenceAudioDir);

    let deletedFiles = 0;

    for (const chunk of session.chunks) {
        const resolved = path.resolve(chunk.audio_path);

        if (!resolved.startsWith(audioRoot + path.sep)) {
            console.warn(
                '[AURA CONFERENCE] Skipping chunk outside the audio directory:',
                chunk.audio_path
            );
            continue;
        }

        try {
            fs.unlinkSync(resolved);
            deletedFiles += 1;
        } catch (error) {
            // A missing file is not a reason to leave the row behind.
            if (error.code !== 'ENOENT') {
                console.warn(
                    '[AURA CONFERENCE] Could not delete chunk:',
                    resolved,
                    error.message
                );
            }
        }
    }

    db.prepare(`
        DELETE FROM conferences WHERE id = ?
    `).run(conferenceId);

    return { deletedFiles };
}

module.exports = {
    createSession,
    addChunk,
    finishSession,
    getSession,
    listSessions,
    deleteSession,
    setStatus,
    setTopicStatus,
    saveTranscript,
    saveExtraction,
    listTopics,
    updateTopic,
    resetInFlightStatuses
};
