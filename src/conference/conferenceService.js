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
 * Returns one session with its chunks in capture order.
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

    return {
        ...session,
        chunks
    };
}

/**
 * Lists recent sessions for the Conference view.
 *
 * @param {number} limit
 * @returns {Array}
 */
function listSessions(limit = 50) {
    return db.prepare(`
        SELECT
            c.*,
            COUNT(ch.id) AS chunk_count
        FROM conferences c
        LEFT JOIN conference_chunks ch
            ON ch.conference_id = c.id
        GROUP BY c.id
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
    deleteSession
};
