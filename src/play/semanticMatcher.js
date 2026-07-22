// CJK scripts (Han, Hiragana/Katakana, Hangul) don't separate words with
// spaces, so whitespace tokenization would treat an entire Chinese or
// Japanese phrase as ONE token and matching would only succeed on exact
// full-phrase equality. Standard fix: split CJK runs into overlapping
// character bigrams (plus single chars for 1-char runs), which approximates
// word units well enough for overlap scoring. Applied identically to both
// the spoken input and the trigger text, so both sides stay comparable.
const CJK_RUN = new RegExp(
    '[\\u2E80-\\u2FDF\\u3040-\\u30FF\\u31F0-\\u31FF' +
    '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF]+',
    'g'
);

function cjkBigrams(run) {
    if (run.length === 1) {
        return [run];
    }

    const grams = [];

    for (let i = 0; i < run.length - 1; i++) {
        grams.push(run.slice(i, i + 2));
    }

    return grams;
}

function tokenize(text) {
    if (!text) return [];

    // Unicode-safe cleanup: keep letters/digits from every script. The old
    // /[^\w\s]/ regex was ASCII-only and deleted all non-Latin characters.
    const cleaned = text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_\s]/gu, ' ');

    const tokens = [];

    for (const rawToken of cleaned.split(/\s+/)) {
        if (!rawToken) continue;

        // Split each token into CJK runs and non-CJK runs; expand CJK runs
        // into bigrams, keep other runs as whole word tokens.
        let lastIndex = 0;

        for (const match of rawToken.matchAll(CJK_RUN)) {
            const before = rawToken.slice(lastIndex, match.index);

            if (before) tokens.push(before);

            tokens.push(...cjkBigrams(match[0]));
            lastIndex = match.index + match[0].length;
        }

        const tail = rawToken.slice(lastIndex);

        if (tail) tokens.push(tail);
    }

    return tokens;
}

function scoreKeywordOverlap(inputText, triggerText) {
    const inputTokens = new Set(tokenize(inputText));
    const triggerTokens = new Set(tokenize(triggerText));

    if (inputTokens.size === 0 || triggerTokens.size === 0) {
        return 0;
    }

    let matches = 0;

    for (const token of inputTokens) {
        if (triggerTokens.has(token)) {
            matches++;
        }
    }

    return matches / triggerTokens.size;
}

module.exports = {
    tokenize,
    scoreKeywordOverlap
};
