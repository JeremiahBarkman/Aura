/**
 * Aura Image Search Import Service
 *
 * Purpose:
 * Converts normalized SerpAPI image search results into Aura draft records.
 *
 * This service:
 * - downloads internet images locally
 * - creates draft source_items
 * - creates summaries
 * - creates trigger_texts
 * - creates generated_images rows
 * - stores image-search source metadata
 * - assigns records to an optional Library Group
 *
 * Important:
 * Imported records are ALWAYS created as draft.
 * They should not participate in Play Mode until reviewed and marked complete.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('../db/connection');
const paths = require('../config/paths');

const {
    generateImageImportProducts
} = require('./imageEnrichmentService');

const stopwordService = require('../text/stopwordService');

/**
 * Local directory for imported internet images.
 *
 * Aura stores imported images locally so Play Mode does not depend
 * on external image URLs at runtime.
 *
 * Must come from paths.js, not __dirname: in the packaged app the
 * writable data root is AURA_DATA_DIR (userData), while __dirname
 * points into the read-only install folder that the /imported-images
 * static route never serves from.
 */
const IMPORT_IMAGE_DIR = path.join(paths.imagesDir, 'imports');

/**
 * Ensures the import directory exists before saving files.
 */
function ensureImportImageDir() {
    fs.mkdirSync(IMPORT_IMAGE_DIR, {
        recursive: true
    });
}

/**
 * Creates a safe local filename for an imported image.
 *
 * Uses a hash so filenames are stable and avoid unsafe URL characters.
 */
function createImportImageFilename(imageUrl) {
    const hash = crypto
        .createHash('sha256')
        .update(imageUrl)
        .digest('hex')
        .slice(0, 16);

    return `import-${Date.now()}-${hash}.jpg`;
}

/**
 * Downloads an image from a remote URL and saves it locally.
 *
 * @param {string} imageUrl
 * Remote image URL from SerpAPI.
 *
 * @returns {Promise<string>}
 * Local absolute image path.
 */
async function downloadImageToLocalFile(imageUrl) {
    if (!imageUrl) {
        throw new Error('Image URL is required for import.');
    }

    ensureImportImageDir();

    const response = await fetch(imageUrl);

    if (!response.ok) {
        throw new Error(
            `Image download failed with status ${response.status}`
        );
    }

    const arrayBuffer = await response.arrayBuffer();

    const fileName = createImportImageFilename(imageUrl);

    const localPath = path.join(
        IMPORT_IMAGE_DIR,
        fileName
    );

    fs.writeFileSync(
        localPath,
        Buffer.from(arrayBuffer)
    );

    return localPath;
}

/**
 * Builds initial source text for an imported image.
 *
 * This intentionally uses raw metadata first.
 * Ollama enrichment can improve this later.
 */
function buildSourceText({ searchQuery, result }) {
    return [
        `Search query: ${searchQuery}`,
        `Title: ${result.title || ''}`,
        `Source: ${result.source || ''}`,
        `Link: ${result.link || ''}`
    ]
        .filter(Boolean)
        .join('\n');
}

/**
 * Builds a first-pass image summary for draft review.
 */
function buildSummaryText({ searchQuery, result }) {
    return (
        result.title ||
        `Imported image result for ${searchQuery}`
    );
}

/**
 * Builds a first-pass image prompt.
 *
 * This is intentionally conservative.
 * Ollama can later transform metadata into a richer prompt.
 */
function buildImagePrompt({ searchQuery, result }) {
    return [
        result.title,
        searchQuery,
        result.source
    ]
        .filter(Boolean)
        .join(', ');
}

/**
 * Builds simple cleaned trigger text.
 *
 * This first pass uses metadata only.
 * Later, Ollama should generate better trigger phrases.
 */
function buildCleanedTriggerText({ searchQuery, result }) {
    return [
        searchQuery,
        result.title,
        result.source
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        // Unicode-safe: keep letters/digits from every script. The previous
        // [^a-z0-9\s] deleted ALL non-ASCII characters, destroying trigger
        // text for any non-English search.
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Imports one normalized image-search result as a draft Aura record.
 *
 * @param {Object} params
 * @param {string} params.searchQuery
 * Original user image search query.
 *
 * @param {Object} params.result
 * Normalized SerpAPI image result.
 *
 * @param {number|null} params.groupId
 * Optional Aura Library Group ID.
 *
 * @returns {Promise<Object>}
 * Created record IDs and local image path.
 */
async function importImageSearchResult({
    searchQuery,
    result,
    groupId = null
}) {
    const imageUrl =
        result.originalImageUrl ||
        result.thumbnailUrl;

    const localImagePath =
        await downloadImageToLocalFile(imageUrl);

    const rawText =
        buildSourceText({
            searchQuery,
            result
        });

let summaryText;
let imagePrompt;
let rawTriggerText;
let cleanedTriggerText;
let detectedLanguage = null;
let enrichmentModelUsed = 'metadata-import-v1';

try {
    const enrichment =
        await generateImageImportProducts({
            searchQuery,
            result
        });

    detectedLanguage = enrichment.language || null;

    summaryText =
        enrichment.summary_text ||
        buildSummaryText({
            searchQuery,
            result
        });

    imagePrompt =
        enrichment.image_prompt ||
        buildImagePrompt({
            searchQuery,
            result
        });

    rawTriggerText =
        enrichment.trigger_candidate_text ||
        buildCleanedTriggerText({
            searchQuery,
            result
        });

    enrichmentModelUsed = 'ollama-import-v1';

} catch (error) {
    console.error(
        'Image import enrichment failed; falling back to metadata:',
        error.message
    );

    summaryText =
        buildSummaryText({
            searchQuery,
            result
        });

    imagePrompt =
        buildImagePrompt({
            searchQuery,
            result
        });

    rawTriggerText =
        buildCleanedTriggerText({
            searchQuery,
            result
        });
}

// Play Mode trigger matching depends on the top-50 stopwords being
// stripped from every record's trigger text, same as the capture/draft
// flow (recordModeService). Imported records must not skip this step.
cleanedTriggerText = stopwordService.removeTop50StopWords(rawTriggerText);

    /**
     * Insert source item as DRAFT.
     *
     * Imported internet records must be reviewed
     * before they can become Play Mode active.
     */
    const sourceResult = db.prepare(`
        INSERT INTO source_items (
            source_type,
            raw_text,
            source_path,
            duration_ms,
            record_status,
            group_id,
            language
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        'image_search_import',
        rawText,
        result.link || null,
        null,
        'draft',
        groupId,
        detectedLanguage
    );

    const sourceItemId =
        sourceResult.lastInsertRowid;

    /**
     * Create summary row.
     */
    const summaryResult = db.prepare(`
        INSERT INTO summaries (
            source_item_id,
            summary_text,
            image_prompt,
            model_used
        )
        VALUES (?, ?, ?, ?)
    `).run(
        sourceItemId,
        summaryText,
        imagePrompt,
        enrichmentModelUsed
    );

    const summaryId =
        summaryResult.lastInsertRowid;

    /**
     * Create trigger text row.
     */
    db.prepare(`
        INSERT INTO trigger_texts (
            source_item_id,
            original_trigger_text,
            cleaned_trigger_text
        )
        VALUES (?, ?, ?)
    `).run(
        sourceItemId,
        rawTriggerText,
        cleanedTriggerText
    );

    /**
     * Register imported image as an Aura image record.
     *
     * Even though the image was not generated by ComfyUI,
     * it is stored in generated_images because this is the table
     * Aura already uses for Play Mode image lookup.
     */
    const imageResult = db.prepare(`
        INSERT INTO generated_images (
            source_item_id,
            summary_id,
            image_path,
            prompt_id,
            workflow_name,
            model_used,
            is_active,
            is_favorite
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        sourceItemId,
        summaryId,
        localImagePath,
        null,
        'serpapi-image-import',
        'serpapi',
        1,
        0
    );

    const generatedImageId =
        imageResult.lastInsertRowid;

            /**
     * Imported image becomes the initial primary image.
     *
     * Every image-search import currently creates one image per record,
     * so this image should automatically become the record's primary image.
     */
    db.prepare(`
        UPDATE source_items
        SET primary_image_id = ?
        WHERE id = ?
    `).run(
        generatedImageId,
        sourceItemId
    );

    /**
     * Preserve original internet-search metadata.
     */
    db.prepare(`
        INSERT INTO image_search_imports (
            source_item_id,
            generated_image_id,
            search_query,
            result_title,
            result_source,
            result_link,
            original_image_url,
            thumbnail_url
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        sourceItemId,
        generatedImageId,
        searchQuery,
        result.title || null,
        result.source || null,
        result.link || null,
        result.originalImageUrl || null,
        result.thumbnailUrl || null
    );

    return {
        sourceItemId,
        summaryId,
        generatedImageId,
        localImagePath,
        recordStatus: 'draft'
    };
}

/**
 * Imports multiple normalized image-search results.
 *
 * @param {Object} params
 * @param {string} params.searchQuery
 * @param {Array} params.results
 * @param {number|null} params.groupId
 *
 * @returns {Promise<Array>}
 */
async function importImageSearchResults({
    searchQuery,
    results,
    groupId = null
}) {
    // Each import pays a remote image download plus an Ollama enrichment
    // round-trip; run a few concurrently instead of strictly one at a time.
    // DB writes stay safe -- better-sqlite3 is synchronous, so inserts
    // serialize naturally. Kept small so Ollama isn't flooded.
    const CONCURRENCY = 3;

    const imported = new Array(results.length);

    let nextIndex = 0;

    async function worker() {
        while (nextIndex < results.length) {
            const index = nextIndex++;
            const result = results[index];

            try {
                const importedRecord =
                    await importImageSearchResult({
                        searchQuery,
                        result,
                        groupId
                    });

                imported[index] = {
                    success: true,
                    ...importedRecord
                };
            } catch (error) {
                imported[index] = {
                    success: false,
                    error: error.message,
                    title: result.title || '',
                    imageUrl:
                        result.originalImageUrl ||
                        result.thumbnailUrl ||
                        ''
                };
            }
        }
    }

    const workerCount = Math.min(CONCURRENCY, results.length);

    await Promise.all(
        Array.from({ length: workerCount }, () => worker())
    );

    return imported;
}

module.exports = {
    importImageSearchResult,
    importImageSearchResults
};