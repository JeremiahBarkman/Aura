/**
 * Aura Conference Processing
 * ============================================================================
 *
 * Purpose:
 * Drives a recorded conference from stored audio to reviewable subjects:
 *
 *   recorded -> transcribing -> extracting -> review
 *
 * Runs as a background job. Transcribing a meeting takes minutes and the
 * extraction pass on a local 24B model takes minutes more, so the HTTP request
 * that starts it returns immediately and the UI polls the session.
 *
 * Owns:
 * - the transcribe -> extract sequence and the status transitions through it
 * - the in-process job registry that stops a conference being processed twice
 *
 * Does NOT own:
 * - audio capture (public/index.html)
 * - the extraction prompt (topicExtractionService)
 * - dispatching prompts to ComfyUI or SerpAPI
 */

const speechService = require('../speech/localWhisperService');
const stopwordService = require('../text/stopwordService');
const comfyUiService = require('../image/comfyUiService');
const conferenceService = require('./conferenceService');
const topicExtractionService = require('./topicExtractionService');

/**
 * Conference ids currently being processed.
 *
 * Processing is idempotent in its writes (topics are replaced, not appended),
 * but running two passes at once would have them race for the same rows and
 * would put two multi-minute jobs on one GPU. State is in-process only, which
 * matches the server's lifetime -- a conference left mid-flight by a crash is
 * recovered by the stale-status reset below rather than by durable job state.
 */
const activeJobs = new Set();

function isProcessing(conferenceId) {
    return activeJobs.has(Number(conferenceId));
}

/**
 * Transcribes every chunk in order and joins them into one transcript.
 *
 * Chunks are transcribed one at a time rather than concurrently: the Whisper
 * service is a single Flask process in front of one model, so parallel
 * requests queue inside it anyway while making failures harder to attribute.
 *
 * A failed chunk does not abort the meeting. Losing five minutes of a
 * forty-minute meeting is recoverable; losing the whole transcript because one
 * segment was malformed is not. The gap is marked in place so it is visible in
 * the transcript rather than silently closed over.
 */
async function transcribeConference(conferenceId) {
    const session = conferenceService.getSession(conferenceId);

    if (!session || session.chunks.length === 0) {
        throw new Error('Conference has no recorded audio to transcribe.');
    }

    const parts = [];
    let detectedLanguage = null;
    let failedChunks = 0;

    for (const chunk of session.chunks) {
        try {
            const result = await speechService.transcribeAudioFile(chunk.audio_path);

            if (result.text) {
                parts.push(result.text);
            }

            if (!detectedLanguage && result.language) {
                detectedLanguage = result.language;
            }
        } catch (error) {
            failedChunks += 1;

            console.error(
                `[AURA CONFERENCE] Chunk ${chunk.chunk_index} failed to transcribe:`,
                error.message
            );

            parts.push(`[segment ${chunk.chunk_index + 1} could not be transcribed]`);
        }
    }

    return {
        transcript: parts.join(' ').trim(),
        language: detectedLanguage,
        failedChunks
    };
}

/**
 * Runs the full pipeline for one conference.
 *
 * Status is advanced before each stage rather than after, so a session stuck
 * in "transcribing" names the stage that hung.
 */
async function processConference(conferenceId) {
    const id = Number(conferenceId);

    if (activeJobs.has(id)) {
        throw new Error('This conference is already being processed.');
    }

    const session = conferenceService.getSession(id);

    if (!session) {
        throw new Error(`Conference ${id} not found.`);
    }

    if (session.status === 'recording') {
        throw new Error('Stop the recording before processing it.');
    }

    activeJobs.add(id);

    // Deliberately not awaited: the caller returns to the client immediately
    // and the UI follows progress by polling the session.
    runPipeline(id).catch(error => {
        console.error('[AURA CONFERENCE] Processing failed:', error);
    });

    return conferenceService.getSession(id);
}

async function runPipeline(id) {
    try {
        conferenceService.setStatus(id, 'transcribing');

        const { transcript, language, failedChunks } =
            await transcribeConference(id);

        if (!transcript) {
            throw new Error(
                'Transcription produced no text. The recording may be silent.'
            );
        }

        conferenceService.saveTranscript(id, transcript, language);

        conferenceService.setStatus(id, 'extracting');

        /*
            Give the extraction model as much of the card as possible. It is
            the most memory-hungry thing Aura does -- a 24B model with a context
            sized to the whole transcript.

            This measurably changes nothing on an 8 GB card, where the model
            cannot fit regardless (see comfyUiService.freeMemory). It is here
            for hardware where it can, and costs about a second.

            Asked for after transcription rather than before, so Whisper is
            already done with the GPU and a session that fails earlier never
            pays for it.
        */
        await comfyUiService.freeMemory();

        const session = conferenceService.getSession(id);

        const extraction = await topicExtractionService.extractTopics({
            transcript,
            metadata: {
                title: session.title,
                date: session.created_at
            }
        });

        // Play Mode matches against stopword-stripped trigger text for every
        // other kind of record; conference subjects go through the same
        // cleanup or they would score differently from everything else in the
        // library.
        const topics = extraction.subjects.map(subject => ({
            ...subject,
            cleanedTriggerText: stopwordService.removeTop50StopWords(
                subject.triggerCandidateText || subject.title
            )
        }));

        conferenceService.saveExtraction(id, {
            sourceText: extraction.sourceText,
            language: extraction.language,
            topics
        });

        conferenceService.setStatus(
            id,
            'review',
            failedChunks > 0
                ? `${failedChunks} audio segment(s) could not be transcribed.`
                : null
        );
    } catch (error) {
        conferenceService.setStatus(id, 'failed', error.message);
    } finally {
        activeJobs.delete(id);
    }
}

/**
 * Clears statuses left mid-flight by a server restart.
 *
 * activeJobs lives in process memory, so a conference that was transcribing
 * when the server stopped would otherwise sit in that status forever with
 * nothing working on it and no way to retry.
 */
function resetStaleProcessing() {
    const reset = conferenceService.resetInFlightStatuses();

    if (reset > 0) {
        console.log(
            `[AURA CONFERENCE] Reset ${reset} conference(s) left mid-processing by a restart.`
        );
    }

    return reset;
}

module.exports = {
    processConference,
    isProcessing,
    resetStaleProcessing
};
