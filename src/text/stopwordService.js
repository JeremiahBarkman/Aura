// English top-50 stopwords. Only applied when the text is predominantly
// English/Latin -- stripping English stopwords from other languages is
// harmful ("a", "me", "no" are common Spanish words; "on" is French, etc.).
const top50StopWords = new Set([
    'the', 'be', 'to', 'of', 'and',
    'a', 'in', 'that', 'have', 'i',
    'it', 'for', 'not', 'on', 'with',
    'he', 'as', 'you', 'do', 'at',
    'this', 'but', 'his', 'by', 'from',
    'they', 'we', 'say', 'her', 'she',
    'or', 'an', 'will', 'my', 'one',
    'all', 'would', 'there', 'their', 'what',
    'so', 'up', 'out', 'if', 'about',
    'who', 'get', 'which', 'go', 'me'
]);

// CJK scripts (Chinese Han, Japanese Hiragana/Katakana, Korean Hangul) do
// not separate words with spaces, so token-level processing must keep those
// characters intact rather than treating a whole sentence as one token.
const CJK_RANGE =
    '\\u2E80-\\u2FDF\\u3040-\\u30FF\\u31F0-\\u31FF\\u3400-\\u4DBF' +
    '\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF';

const NON_WORD_PATTERN =
    new RegExp(`[^\\p{L}\\p{N}_\\s]`, 'gu');

function isMostlyLatin(text) {
    let latin = 0;
    let other = 0;

    for (const ch of text) {
        if (/[a-zA-Z]/.test(ch)) latin++;
        else if (/\p{L}/u.test(ch)) other++;
    }

    return latin >= other;
}

/**
 * Normalizes text for trigger matching.
 *
 * - Unicode-safe: keeps letters/digits from every script (the previous
 *   ASCII-only regex silently deleted all CJK/Cyrillic/Arabic/accented
 *   characters).
 * - English stopwords are removed only when the text is predominantly
 *   Latin-script, so other languages keep their short common words.
 */
function removeTop50StopWords(text) {
    if (!text) {
        return '';
    }

    const cleaned = text
        .toLowerCase()
        .replace(NON_WORD_PATTERN, ' ');

    const applyStopwords = isMostlyLatin(cleaned);

    return cleaned
        .split(/\s+/)
        .filter(word => word.length > 0)
        .filter(word => !applyStopwords || !top50StopWords.has(word))
        .join(' ');
}

module.exports = {
    removeTop50StopWords,
    CJK_RANGE
};
