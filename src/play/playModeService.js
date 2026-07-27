const db = require('../db/connection');
const stopwordService = require('../text/stopwordService');
const semanticMatcher = require('./semanticMatcher');
const embeddingService = require('../llm/embeddingService');
const auraConfig = require('../config/auraConfig');

// This query runs on every speech chunk (every few seconds while Play Mode
// is live), so cache the compiled statements instead of re-preparing the
// SQL string each call.
const statementCache = new Map();

function prepareCached(sql) {
    if (!statementCache.has(sql)) {
        statementCache.set(sql, db.prepare(sql));
    }

    return statementCache.get(sql);
}

// -----------------------------------------------------------------------------
// Trigger Embeddings
// -----------------------------------------------------------------------------
// Embeddings are cached in the trigger_embeddings table (invalidated when
// trigger text is edited) plus an in-memory map for the live match loop.

const memoryEmbeddings = new Map(); // source_item_id -> { model, vector }

function loadStoredEmbedding(sourceItemId) {
    const cached = memoryEmbeddings.get(sourceItemId);

    if (cached && cached.model === embeddingService.EMBED_MODEL) {
        return cached.vector;
    }

    const row = prepareCached(`
        SELECT model, embedding
        FROM trigger_embeddings
        WHERE source_item_id = ?
    `).get(sourceItemId);

    if (!row || row.model !== embeddingService.EMBED_MODEL) {
        return null;
    }

    const vector = embeddingService.bufferToVector(row.embedding);

    memoryEmbeddings.set(sourceItemId, {
        model: row.model,
        vector
    });

    return vector;
}

function storeEmbedding(sourceItemId, vector) {
    prepareCached(`
        INSERT OR REPLACE INTO trigger_embeddings (
            source_item_id,
            model,
            embedding,
            updated_at
        )
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
        sourceItemId,
        embeddingService.EMBED_MODEL,
        embeddingService.vectorToBuffer(vector)
    );

    memoryEmbeddings.set(sourceItemId, {
        model: embeddingService.EMBED_MODEL,
        vector
    });
}

function invalidateEmbedding(sourceItemId) {
    memoryEmbeddings.delete(sourceItemId);

    prepareCached(`
        DELETE FROM trigger_embeddings
        WHERE source_item_id = ?
    `).run(sourceItemId);
}

/**
 * Ensures every candidate record has a cached trigger embedding.
 * Missing ones are embedded in a single batched Ollama call.
 *
 * Returns a Map of source_item_id -> Float32Array (only for records that
 * have a vector), or null when the embedding service is unavailable.
 */
async function ensureTriggerEmbeddings(records) {
    const vectors = new Map();
    const missing = [];

    for (const record of records) {
        const vector = loadStoredEmbedding(record.source_item_id);

        if (vector) {
            vectors.set(record.source_item_id, vector);
        } else if (record.cleaned_trigger_text) {
            missing.push(record);
        }
    }

    if (missing.length) {
        const embedded = await embeddingService.embedTexts(
            missing.map(record => record.cleaned_trigger_text)
        );

        if (embedded === null) {
            return vectors.size ? vectors : null;
        }

        for (let i = 0; i < missing.length; i++) {
            storeEmbedding(missing[i].source_item_id, embedded[i]);
            vectors.set(missing[i].source_item_id, embedded[i]);
        }
    }

    return vectors;
}

// Raw cosine similarity between arbitrary short texts sits well above zero
// even for unrelated content (~0.3-0.5 for nomic-embed-text). Rescale so
// only meaningfully-related pairs produce a usable score comparable to the
// 0..1 keyword score that the UI threshold slider was calibrated against.
function semanticScoreFromCosine(cosine) {
    return Math.max(0, (cosine - 0.5) * 2);
}

// -----------------------------------------------------------------------------
// Per-record Image Rotation
// -----------------------------------------------------------------------------
// A record's primary image always shows first. If the SAME record wins the
// best-match slot again while its image is still the one on screen, advance
// to that record's next active image (ordered by id, after the primary)
// instead of repeating the primary -- once every image has been shown, wrap
// back around to the primary. A match for a DIFFERENT record (or no match at
// all) resets the rotation, so reactivating a trigger later always starts
// from the primary again.
const recordRotationIndex = new Map(); // source_item_id -> last-shown index
let lastActiveSourceItemId = null;

function resolveRotatedImage(record) {
    const images = prepareCached(`
        SELECT id, image_path
        FROM generated_images
        WHERE source_item_id = ?
          AND deleted_at IS NULL
          AND is_active = 1
        ORDER BY
            CASE WHEN id = ? THEN 0 ELSE 1 END,
            id ASC
    `).all(record.source_item_id, record.primary_image_id);

    if (images.length <= 1) {
        return record;
    }

    const wasActive =
        lastActiveSourceItemId === record.source_item_id;

    const previousIndex =
        recordRotationIndex.get(record.source_item_id) || 0;

    const nextIndex =
        wasActive
            ? (previousIndex + 1) % images.length
            : 0;

    recordRotationIndex.set(record.source_item_id, nextIndex);

    const chosen = images[nextIndex];

    return {
        ...record,
        image_id: chosen.id,
        image_path: chosen.image_path
    };
}

/**
 * Finds the best matching images for a spoken phrase.
 *
 * Scoring is hybrid: exact keyword overlap (original behavior) combined
 * with embedding cosine similarity when the embedding service is
 * available and semanticMatchingEnabled is on. The final score is the
 * better of the two, so semantic matching can only widen matches, never
 * suppress an exact keyword hit.
 *
 * If groupId is null:
 *     Search all COMPLETE records.
 *
 * If groupId is provided:
 *     Search only COMPLETE records assigned to that group.
 */
async function findBestImageMatches(
    spokenText,
    limit = 5,
    groupId = null
) {
    const cleanedInput =
        stopwordService.removeTop50StopWords(
            spokenText
        );

    let sql = `
        SELECT
            si.id AS source_item_id,
            si.raw_text,
            si.record_status,
            si.group_id,
            si.primary_image_id,

            tt.cleaned_trigger_text,

            COALESCE(primary_gi.id, fallback_gi.id)
                AS image_id,

            COALESCE(primary_gi.image_path, fallback_gi.image_path)
                AS image_path,

            COALESCE(primary_gi.is_active, fallback_gi.is_active)
                AS is_active,

            COALESCE(primary_gi.is_favorite, fallback_gi.is_favorite)
                AS is_favorite

        FROM source_items si

        JOIN trigger_texts tt
            ON tt.source_item_id = si.id

        LEFT JOIN generated_images primary_gi
            ON primary_gi.id = si.primary_image_id
            AND primary_gi.source_item_id = si.id
            AND primary_gi.deleted_at IS NULL
            AND primary_gi.is_active = 1

        LEFT JOIN generated_images fallback_gi
            ON fallback_gi.id = (
                SELECT gi2.id
                FROM generated_images gi2
                WHERE gi2.source_item_id = si.id
                AND gi2.deleted_at IS NULL
                AND gi2.is_active = 1
                ORDER BY gi2.id ASC
                LIMIT 1
            )

        WHERE
            si.record_status = 'complete'
            AND (
                primary_gi.id IS NOT NULL
                OR fallback_gi.id IS NOT NULL
            )
    `;

    const params = [];

    if (groupId !== null) {
        sql += `
            AND si.group_id = ?
        `;

        params.push(groupId);
    }

    sql += `
        ORDER BY si.id DESC
    `;

    const records =
        prepareCached(sql).all(...params);

    // Semantic side: embed candidates + the spoken input. Any failure
    // degrades to keyword-only matching (the original behavior).
    const semanticEnabled =
        auraConfig.readConfig().semanticMatchingEnabled !== false;

    let triggerVectors = null;
    let inputVector = null;

    if (semanticEnabled && cleanedInput && records.length) {
        triggerVectors = await ensureTriggerEmbeddings(records);

        if (triggerVectors) {
            const embeddedInput =
                await embeddingService.embedTexts([cleanedInput]);

            inputVector = embeddedInput ? embeddedInput[0] : null;
        }
    }

    console.log(
        '[PlayMode]',
        {
            groupId,
            candidateCount: records.length,
            semantic: Boolean(inputVector)
        }
    );

    const scored = records
        .map(record => {

            const keywordScore =
                semanticMatcher.scoreKeywordOverlap(
                    cleanedInput,
                    record.cleaned_trigger_text
                );

            let semanticScore = 0;

            if (inputVector && triggerVectors) {
                const triggerVector =
                    triggerVectors.get(record.source_item_id);

                if (triggerVector) {
                    semanticScore = semanticScoreFromCosine(
                        embeddingService.cosineSimilarity(
                            inputVector,
                            triggerVector
                        )
                    );
                }
            }

            return {
                ...record,
                cleanedInput,
                keyword_score: keywordScore,
                semantic_score: semanticScore,
                score: Math.max(keywordScore, semanticScore)
            };
        })
        .filter(record => record.score > 0)
        .sort((a, b) => {

            if (b.score !== a.score) {
                return b.score - a.score;
            }

            return (
                (b.is_favorite || 0) -
                (a.is_favorite || 0)
            );
        })
        .slice(0, limit);

    // Only the top match is ever actually displayed (playRoutes.js only acts
    // on matches[0]), and only if its score clears the UI's minimumMatchScore
    // threshold (checked client-side) -- a below-threshold top match never
    // reaches the screen, so it must not consume a rotation step either.
    const minimumMatchScore =
        Number(auraConfig.readConfig().minimumMatchScore ?? 0);

    if (scored.length && scored[0].score >= minimumMatchScore) {
        scored[0] = resolveRotatedImage(scored[0]);
        lastActiveSourceItemId = scored[0].source_item_id;
    } else {
        lastActiveSourceItemId = null;
    }

    return scored;
}

module.exports = {
    findBestImageMatches,
    invalidateEmbedding
};
