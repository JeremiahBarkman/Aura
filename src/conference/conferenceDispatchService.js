/**
 * Aura Conference Dispatch
 * ============================================================================
 *
 * Purpose:
 * Turns approved conference subjects into Aura draft records: generates images
 * through ComfyUI, searches for them through SerpAPI, and writes the records
 * that carry them into the Library.
 *
 * One draft record per subject, not per image. A subject is the thing Play
 * Mode matches on -- it has one trigger phrase and one summary -- and its
 * generated and searched images are alternatives for the same moment. This is
 * where conference import differs from Image Search import, which creates a
 * record per downloaded image because each result stands alone there.
 *
 * Owns:
 * - the per-subject dispatch sequence and its status transitions
 * - the draft records, images and provenance rows it writes
 *
 * Does NOT own:
 * - deciding which subjects to dispatch (image_strategy and the review screen)
 * - the prompts themselves (topicExtractionService)
 */

const db = require('../db/connection');

const sourceRepository = require('../db/repositories/sourceRepository');
const summaryRepository = require('../db/repositories/summaryRepository');
const triggerTextRepository = require('../db/repositories/triggerTextRepository');
const generatedImageRepository = require('../db/repositories/generatedImageRepository');

const comfyUiService = require('../image/comfyUiService');
const { searchImages } = require('../import/serpApiImageSearchService');
const { downloadImageToLocalFile } = require('../import/imageSearchImportService');

const conferenceService = require('./conferenceService');

/**
 * Ceiling on downloads per searched subject.
 *
 * SerpAPI is metered and is the one place meeting content leaves the machine,
 * so the count is bounded here as well as in the request. A dozen subjects at
 * an unbounded batch size is a surprising bill from one button.
 */
const MAX_IMAGES_PER_SEARCH = 10;
const DEFAULT_IMAGES_PER_SEARCH = 3;

const activeJobs = new Set();

function isDispatching(conferenceId) {
    return activeJobs.has(Number(conferenceId));
}

function needsGeneration(strategy) {
    return strategy === 'generate' || strategy === 'both';
}

function needsSearch(strategy) {
    return strategy === 'search' || strategy === 'both';
}

/**
 * Generates one image for a subject and returns a row-ready descriptor.
 *
 * The subject's own negative prompt is passed through rather than falling back
 * to the global one: the extraction model writes exclusions specific to the
 * scene it just described, and those are the ones worth having.
 */
async function generateSubjectImage(topic) {
    const generated = await comfyUiService.generateImageFromWorkflow(
        topic.positive_prompt,
        topic.negative_prompt || null,
        topic.aspect_ratio || null
    );

    const image = generated.images[0];

    if (!image) {
        throw new Error('ComfyUI returned no image.');
    }

    return {
        imagePath: image.storedPath || image.localPath,
        promptId: generated.promptId,
        workflowName: 'aura_background_api.json',
        modelUsed: 'sdxl_lightning_4step.safetensors',
        searchResult: null
    };
}

/**
 * Searches for a subject and downloads up to `limit` results.
 *
 * A result that fails to download is skipped rather than failing the subject;
 * remote image URLs go stale constantly and one dead link should not cost the
 * whole record.
 */
async function searchSubjectImages(topic, limit) {
    const results = await searchImages({
        query: topic.search_query,
        limit
    });

    const images = [];

    for (const result of results.slice(0, limit)) {
        const url = result.originalImageUrl || result.thumbnailUrl;

        if (!url) {
            continue;
        }

        try {
            const localPath = await downloadImageToLocalFile(url);

            images.push({
                imagePath: localPath,
                promptId: null,
                workflowName: 'conference-image-search',
                modelUsed: 'serpapi',
                searchResult: result
            });
        } catch (error) {
            console.warn(
                `[AURA CONFERENCE] Skipping image that failed to download: ${error.message}`
            );
        }
    }

    return images;
}

/**
 * Writes one subject's draft record and everything hanging off it.
 *
 * Done in a single transaction so a subject is either fully in the Library or
 * not in it at all -- a source_item with no trigger text would sit in the
 * Library unable to ever match, and would take a manual repair to notice.
 *
 * Image files are downloaded/generated before this runs; only the rows are
 * transactional. better-sqlite3 is synchronous, so no await may appear inside.
 */
const writeSubjectRecord = db.transaction((topic, conference, images) => {
    const sourceItemId = sourceRepository.createSourceItem(
        'conference',
        topic.description || topic.title,
        null,
        null,
        conference.language || null
    );

    // createSourceItem does not take a group, and record_status defaults to
    // 'draft' in the schema -- conference records stay draft until reviewed,
    // same as image-search imports.
    db.prepare('UPDATE source_items SET group_id = ? WHERE id = ?')
        .run(conference.group_id || null, sourceItemId);

    const summaryId = summaryRepository.createSummary(
        sourceItemId,
        topic.description || topic.title,
        topic.positive_prompt || topic.search_query || topic.title,
        'conference-extraction-v1'
    );

    triggerTextRepository.createTriggerText(
        sourceItemId,
        topic.original_trigger_text || topic.title,
        topic.cleaned_trigger_text || topic.title
    );

    let primaryImageId = null;

    for (const image of images) {
        const generatedImageId = generatedImageRepository.createGeneratedImage(
            sourceItemId,
            summaryId,
            image.imagePath,
            image.promptId,
            image.workflowName,
            image.modelUsed
        );

        if (primaryImageId === null) {
            primaryImageId = generatedImageId;
        }

        // Keep provenance for searched images, matching what Image Search
        // import stores, so a conference-sourced image is as traceable as any
        // other imported one.
        if (image.searchResult) {
            db.prepare(`
                INSERT INTO image_search_imports (
                    source_item_id, generated_image_id, search_query,
                    result_title, result_source, result_link,
                    original_image_url, thumbnail_url
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                sourceItemId,
                generatedImageId,
                topic.search_query || '',
                image.searchResult.title || null,
                image.searchResult.source || null,
                image.searchResult.link || null,
                image.searchResult.originalImageUrl || null,
                image.searchResult.thumbnailUrl || null
            );
        }
    }

    if (primaryImageId !== null) {
        db.prepare('UPDATE source_items SET primary_image_id = ? WHERE id = ?')
            .run(primaryImageId, sourceItemId);
    }

    db.prepare(`
        UPDATE conference_topics
        SET status = ?, source_item_id = ?
        WHERE id = ?
    `).run(
        images.length > 0 ? 'done' : 'partial',
        sourceItemId,
        topic.id
    );

    return sourceItemId;
});

/**
 * Starts dispatch for one conference. Returns as soon as the job is accepted.
 */
function dispatchConference(conferenceId, { imagesPerSearch } = {}) {
    const id = Number(conferenceId);

    if (activeJobs.has(id)) {
        throw new Error('This conference is already generating.');
    }

    const conference = conferenceService.getSession(id);

    if (!conference) {
        throw new Error(`Conference ${id} not found.`);
    }

    if (conference.topics.length === 0) {
        throw new Error('This conference has no subjects to generate from.');
    }

    const limit = Math.max(
        1,
        Math.min(
            Number(imagesPerSearch) || DEFAULT_IMAGES_PER_SEARCH,
            MAX_IMAGES_PER_SEARCH
        )
    );

    activeJobs.add(id);

    runDispatch(id, limit).catch(error => {
        console.error('[AURA CONFERENCE] Dispatch failed:', error);
    });

    return conferenceService.getSession(id);
}

async function runDispatch(id, imagesPerSearch) {
    try {
        conferenceService.setStatus(id, 'generating');

        const conference = conferenceService.getSession(id);

        // Subjects run one at a time on purpose. ComfyUI has a single queue, so
        // parallel generation only reorders the wait, and staggering the
        // SerpAPI calls keeps a failure attributable to one subject.
        for (const topic of conference.topics) {
            if (!topic.is_approved) {
                continue;
            }

            // Already has a record: a re-run after a partial failure picks up
            // where it stopped rather than duplicating what already landed.
            if (topic.source_item_id) {
                continue;
            }

            if (topic.image_strategy === 'none') {
                continue;
            }

            await dispatchTopic(topic, conference, imagesPerSearch);
        }

        const finished = conferenceService.getSession(id);

        const done = finished.topics.filter(t => t.status === 'done').length;
        const failed = finished.topics.filter(t => t.status === 'failed').length;

        conferenceService.setStatus(
            id,
            'complete',
            failed > 0
                ? `${done} subject(s) generated, ${failed} failed.`
                : null
        );
    } catch (error) {
        conferenceService.setStatus(id, 'review', error.message);
    } finally {
        activeJobs.delete(id);
    }
}

async function dispatchTopic(topic, conference, imagesPerSearch) {
    conferenceService.setTopicStatus(topic.id, 'generating');

    const images = [];
    const failures = [];

    if (needsGeneration(topic.image_strategy) && topic.positive_prompt) {
        try {
            images.push(await generateSubjectImage(topic));
        } catch (error) {
            failures.push(`generation: ${error.message}`);
            console.error(
                `[AURA CONFERENCE] Generation failed for "${topic.title}":`,
                error.message
            );
        }
    }

    if (needsSearch(topic.image_strategy) && topic.search_query) {
        try {
            images.push(...await searchSubjectImages(topic, imagesPerSearch));
        } catch (error) {
            failures.push(`search: ${error.message}`);
            console.error(
                `[AURA CONFERENCE] Search failed for "${topic.title}":`,
                error.message
            );
        }
    }

    // Nothing to attach and nothing worked: leave the subject alone rather than
    // creating an imageless record. A record with no image can never show
    // anything in Play Mode, and leaving source_item_id unset means a re-run
    // will retry this subject once the cause is fixed.
    if (images.length === 0) {
        conferenceService.setTopicStatus(
            topic.id,
            'failed',
            failures.join('; ') || 'No images were produced.'
        );

        return;
    }

    writeSubjectRecord(topic, conference, images);
}

module.exports = {
    dispatchConference,
    isDispatching
};
