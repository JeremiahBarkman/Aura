/**
 * Aura SerpAPI Image Search Service
 *
 * Purpose:
 * Provides a small, isolated service for querying SerpAPI image search.
 *
 * This module does NOT:
 * - write to the database
 * - create Aura records
 * - mark anything complete
 *
 * It only searches and normalizes image-search results.
 *
 * Pipeline:
 * user query
 * → SerpAPI Google Images
 * → normalized metadata
 * → import pipeline
 */

const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';

/**
 * Searches Google Images through SerpAPI.
 *
 * @param {Object} options
 * @param {string} options.query
 * Search phrase, such as "Moog modular synthesizer".
 *
 * @param {number} options.limit
 * Maximum number of image results to return.
 *
 * @returns {Promise<Array>}
 * Normalized image-search metadata.
 */
async function searchImages({ query, limit = 25 }) {
    const apiKey = process.env.SERPAPI_KEY;

    if (!apiKey) {
        throw new Error('SERPAPI_KEY is missing from .env.');
    }

    if (!query || !query.trim()) {
        throw new Error('Image search query is required.');
    }

    const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));

    const url = new URL(SERPAPI_ENDPOINT);

    url.searchParams.set('engine', 'google_images');
    url.searchParams.set('q', query.trim());
    url.searchParams.set('api_key', apiKey);

    const response = await fetch(url);

    const result = await response.json();

    if (!response.ok) {
        throw new Error(
            result.error ||
            `SerpAPI request failed with status ${response.status}.`
        );
    }

    const images = Array.isArray(result.images_results)
        ? result.images_results
        : [];

    return images.slice(0, safeLimit).map(normalizeImageResult);
}

/**
 * Normalizes a raw SerpAPI image result into Aura's import shape.
 *
 * SerpAPI fields may vary depending on source/result type,
 * so every field is optional-safe.
 *
 * @param {Object} result
 * Raw SerpAPI image result.
 *
 * @returns {Object}
 * Normalized image metadata.
 */
function normalizeImageResult(result) {
    return {
        title: result.title || '',
        source: result.source || '',
        link: result.link || '',
        originalImageUrl: result.original || result.original_image || '',
        thumbnailUrl: result.thumbnail || '',
        position: result.position || null
    };
}

module.exports = {
    searchImages
};