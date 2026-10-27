/**
 * Aura Local Whisper Service Bridge
 * ============================================================================
 *
 * Purpose:
 * Sends local audio files from Aura's Node server to the local Whisper Flask
 * transcription service and provides basic audio-file utilities needed by
 * Record Mode.
 *
 * Owns:
 * - Local Whisper transcription requests
 * - Audio duration lookup through ffprobe
 *
 * Does NOT own:
 * - Browser microphone capture
 * - Record database writes
 * - Ollama summarization
 * - Image generation
 *
 * Dependencies:
 * - Local Whisper service at WHISPER_URL (default http://127.0.0.1:8765)
 * - ffprobe available to the Aura runtime
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Same variable the system status probe reads, so the green Whisper dot and
// the transcription request can never point at different services.
const WHISPER_URL =
    process.env.WHISPER_URL || 'http://127.0.0.1:8765';

/**
 * Transcribes an audio file by sending it to Aura's local Whisper service.
 *
 * Whisper auto-detects the spoken language (the base model covers ~99
 * languages); the detection is surfaced so records can store the language
 * they were spoken in.
 *
 * @param {string} audioPath Absolute or project-relative path to an audio file.
 * @returns {Promise<{text: string, language: string|null}>}
 */
async function transcribeAudioFile(audioPath) {
    const formData = new FormData();

    const audioBuffer = fs.readFileSync(audioPath);
    const fileName = path.basename(audioPath);

    formData.append(
        'audio',
        new Blob([audioBuffer], {
            type: 'audio/webm'
        }),
        fileName
    );

    console.log('[AURA WHISPER] Sending audio to local Whisper service...');

    const response = await fetch(`${WHISPER_URL}/transcribe`, {
        method: 'POST',
        body: formData
    });

    const result = await response.json();

    if (!response.ok) {
        throw new Error(
            result.error ||
            'Local Whisper transcription failed.'
        );
    }

    console.log('[AURA WHISPER] Transcription complete.');

    return {
        text: String(result.text || '').trim(),
        language: result.language
            ? String(result.language).toLowerCase().slice(0, 8)
            : null
    };
}

/**
 * Reads audio duration using ffprobe.
 *
 * Duration is metadata needed by source_items.duration_ms.
 * Returning null is acceptable if duration cannot be detected.
 *
 * @param {string} audioPath Absolute or project-relative path to an audio file.
 * @returns {number|null} Duration in milliseconds.
 */
function getAudioDurationMs(audioPath) {
    const result = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        audioPath
    ], {
        encoding: 'utf8'
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(result.stderr);
    }

    const durationSeconds =
        parseFloat(result.stdout.trim());

    if (Number.isNaN(durationSeconds)) {
        return null;
    }

    return Math.round(durationSeconds * 1000);
}

module.exports = {
    transcribeAudioFile,
    getAudioDurationMs
};