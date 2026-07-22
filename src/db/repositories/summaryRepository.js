const db = require('../connection');

function createSummary(sourceItemId, summaryText, imagePrompt, modelUsed) {
    const stmt = db.prepare(`
        INSERT INTO summaries (
            source_item_id,
            summary_text,
            image_prompt,
            model_used
        )
        VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(sourceItemId, summaryText, imagePrompt, modelUsed);

    return result.lastInsertRowid;
}

module.exports = {
    createSummary
};