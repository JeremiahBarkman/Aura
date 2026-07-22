const speechService = require('../speech/localWhisperService');
const sourceRepository = require('../db/repositories/sourceRepository');
const summaryRepository = require('../db/repositories/summaryRepository');
const triggerTextRepository = require('../db/repositories/triggerTextRepository');
const ollamaService = require('../llm/ollamaService');
const stopwordService = require('../text/stopwordService');

const comfyUiService = require('../image/comfyUiService');
const generatedImageRepository = require('../db/repositories/generatedImageRepository');


async function processTextProducts(sourceItemId, rawText) {
    const textProducts = await ollamaService.generateRecordModeTextProducts(rawText);

    const summaryId = summaryRepository.createSummary(
        sourceItemId,
        textProducts.summary_text,
        textProducts.image_prompt,
        textProducts.model_used
    );

    const cleanedTriggerText = stopwordService.removeTop50StopWords(
        textProducts.trigger_candidate_text
    );

    const triggerTextId = triggerTextRepository.createTriggerText(
        sourceItemId,
        textProducts.trigger_candidate_text,
        cleanedTriggerText
    );

const generated = await comfyUiService.generateImageFromWorkflow(
    textProducts.image_prompt
);

const generatedImage = generated.images[0];

const generatedImageId = generatedImageRepository.createGeneratedImage(
    sourceItemId,
    summaryId,
    // Durable copy under Aura storage, not the volatile ComfyUI output path.
    generatedImage.storedPath || generatedImage.localPath,
    generated.promptId,
    'aura_background_api.json',
    'sdxl_lightning_4step.safetensors'
);

    return {
    summaryId,
    triggerTextId,
    generatedImageId,
    generatedImage,
        language: textProducts.language || null,
        summaryText: textProducts.summary_text,
        imagePrompt: textProducts.image_prompt,
        originalTriggerText: textProducts.trigger_candidate_text,
        cleanedTriggerText
    };
}

async function ingestAudioFile(audioPath) {
    console.log('Transcribing audio...');

const transcription =
    await speechService.transcribeAudioFile(audioPath);

const transcript = transcription.text;

const durationMs =
    speechService.getAudioDurationMs(audioPath);

    // Whisper auto-detects the spoken language; store it with the record so
    // multilingual libraries know what language each record was spoken in.
    const sourceItemId = sourceRepository.createSourceItem(
        'audio_file',
        transcript,
        audioPath,
        durationMs,
        transcription.language
    );

    const savedItem = sourceRepository.getSourceItemById(sourceItemId);
    const textProducts = await processTextProducts(sourceItemId, transcript);

    return {
        sourceItemId,
        transcript,
        durationMs,
        savedItem,
        textProducts
    };
}

async function ingestManualText(rawText) {
    const sourceItemId = sourceRepository.createSourceItem(
        'manual_text',
        rawText,
        null,
        null
    );

    const savedItem = sourceRepository.getSourceItemById(sourceItemId);
    const textProducts = await processTextProducts(sourceItemId, rawText);

    // For typed text there's no Whisper detection; use the language the LLM
    // identified while processing the text products.
    if (textProducts.language) {
        const db = require('../db/connection');
        db.prepare('UPDATE source_items SET language = ? WHERE id = ?')
            .run(textProducts.language, sourceItemId);
    }

    return {
        sourceItemId,
        savedItem,
        textProducts
    };
}

module.exports = {
    ingestAudioFile,
    ingestManualText
};