// ============================================================================
// Aura Embedding Service
// ============================================================================
// Thin wrapper around Ollama's /api/embed endpoint, used by Play Mode
// semantic matching to embed trigger texts and live speech.
//
// Availability is soft: if the embedding model isn't pulled or Ollama is
// down, callers get null and Play Mode falls back to keyword matching.
// A short cooldown prevents re-hitting a failing endpoint on every speech
// chunk.
// ============================================================================

const OLLAMA_URL =
    process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const EMBED_MODEL =
    process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

const FAILURE_COOLDOWN_MS = 60000;

let unavailableUntil = 0;

function isCoolingDown() {
    return Date.now() < unavailableUntil;
}

/**
 * Embeds one or more texts in a single Ollama call.
 *
 * @param {string[]} texts
 * @returns {Promise<Float32Array[]|null>}
 * One vector per input text, or null if the embedding service is
 * unavailable (model not pulled, Ollama down, or cooling down after a
 * recent failure).
 */
async function embedTexts(texts) {
    if (!texts.length) {
        return [];
    }

    if (isCoolingDown()) {
        return null;
    }

    try {
        const response = await fetch(`${OLLAMA_URL}/api/embed`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: EMBED_MODEL,
                input: texts
            })
        });

        if (!response.ok) {
            throw new Error(`Ollama embed failed: ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data.embeddings)) {
            throw new Error('Ollama embed returned no embeddings array.');
        }

        return data.embeddings.map(vector => Float32Array.from(vector));

    } catch (error) {
        unavailableUntil = Date.now() + FAILURE_COOLDOWN_MS;

        console.warn(
            `[EMBEDDINGS] Unavailable (${error.message}). ` +
            `Falling back to keyword matching for ${FAILURE_COOLDOWN_MS / 1000}s.`
        );

        return null;
    }
}

function vectorToBuffer(vector) {
    return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function bufferToVector(buffer) {
    return new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / Float32Array.BYTES_PER_ELEMENT
    );
}

function cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0) {
        return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
        return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = {
    EMBED_MODEL,
    embedTexts,
    vectorToBuffer,
    bufferToVector,
    cosineSimilarity
};
