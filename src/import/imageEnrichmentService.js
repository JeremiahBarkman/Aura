/**
 * Aura Image Import Enrichment Service
 *
 * Purpose:
 * Uses Ollama to turn image-search metadata into better Aura text products.
 *
 * This service does not write to the database.
 */

function extractJsonObject(text) {
    let cleaned = String(text || '').trim();

    cleaned = cleaned
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();

    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1) {
        throw new Error(`No JSON object found in Ollama response:\n${text}`);
    }

    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
}

const auraConfig = require('../config/auraConfig');

const OLLAMA_URL =
    process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const OLLAMA_MODEL =
    process.env.OLLAMA_MODEL ||
    'hf.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF:latest';

async function generateImageImportProducts({
    searchQuery,
    result
}) {
    // Settings UI override takes precedence; env var / built-in default.
    const model = auraConfig.readConfig().ollamaModel || OLLAMA_MODEL;

    const title = result.title || '';
    const source = result.source || '';
    const link = result.link || '';

    const prompt = `
You are processing an imported image-search result for Aura, an AI virtual webcam background app.

Return ONLY valid JSON with these fields:
{
  "language": "...",
  "summary_text": "...",
  "image_prompt": "...",
  "trigger_candidate_text": "..."
}

Rules:
- language: the ISO 639-1 code of the search query's language (e.g. "en", "es", "zh", "ar").
- summary_text: describe the likely visual subject in one sentence, IN THE SAME LANGUAGE as the search query.
- image_prompt: create a concise image-generation prompt for a webcam background, ALWAYS IN ENGLISH regardless of the query language.
- trigger_candidate_text: create searchable phrases useful for matching spoken words, IN THE SAME LANGUAGE as the search query (they are matched against the user's speech).
- Use only the search metadata provided.
- Do not invent unrelated content.
- Do not include markdown.
- Do not include explanations.

Search query:
${searchQuery}

Image result title:
${title}

Image result source:
${source}

Image result link:
${link}
`;

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model,
            prompt,
            stream: false,
            format: 'json'
        })
    });

    if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
            `Ollama request failed: ${response.status}\n${errorText}`
        );
    }

    const data = await response.json();

    const parsed = extractJsonObject(data.response);

    return {
        language: String(parsed.language || '').toLowerCase().slice(0, 8) || null,
        summary_text: parsed.summary_text || '',
        image_prompt: parsed.image_prompt || '',
        trigger_candidate_text: parsed.trigger_candidate_text || ''
    };
}

module.exports = {
    generateImageImportProducts
};