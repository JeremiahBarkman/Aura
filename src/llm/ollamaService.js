function extractJsonObject(text) {
    let cleaned = text.trim();

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

    const jsonText = cleaned.slice(firstBrace, lastBrace + 1);

    return JSON.parse(jsonText);
}

const auraConfig = require('../config/auraConfig');

const OLLAMA_URL =
    process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const OLLAMA_MODEL =
    process.env.OLLAMA_MODEL ||
    'hf.co/byteshape/Devstral-Small-2-24B-Instruct-2512-GGUF:latest';

// Settings UI override takes precedence; env var / built-in is the default.
function resolveModel() {
    return auraConfig.readConfig().ollamaModel || OLLAMA_MODEL;
}

async function generateRecordModeTextProducts(rawText) {
    const model = resolveModel();

    const prompt = `
You are processing source text for Aura, an AI virtual webcam background app.

Return ONLY valid JSON with these fields:
{
  "language": "...",
  "summary_text": "...",
  "image_prompt": "...",
  "trigger_candidate_text": "..."
}

Rules:
- language: the ISO 639-1 code of the source text's language (e.g. "en", "es", "zh", "ar").
- summary_text: summarize the main visual idea of the text block, written IN THE SAME LANGUAGE as the source text.
- image_prompt: create a coherent image-generation prompt for a background image, ALWAYS IN ENGLISH (image models expect English) regardless of the source language.
- trigger_candidate_text: rewrite the original text into meaningful searchable phrases, IN THE SAME LANGUAGE as the source text (these phrases are matched against the user's spoken words, so they must be in the language the user speaks).
- Do not include markdown.
- Do not include explanations.
- Do not invent unrelated content.

Source text:
${rawText}
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
        trigger_candidate_text: parsed.trigger_candidate_text || '',
        model_used: model
    };
}

module.exports = {
    generateRecordModeTextProducts
};