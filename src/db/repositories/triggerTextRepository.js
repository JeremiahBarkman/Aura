const db = require('../connection');

function createTriggerText(sourceItemId, originalTriggerText, cleanedTriggerText) {
    const stmt = db.prepare(`
        INSERT INTO trigger_texts (
            source_item_id,
            original_trigger_text,
            cleaned_trigger_text
        )
        VALUES (?, ?, ?)
    `);

    const result = stmt.run(sourceItemId, originalTriggerText, cleanedTriggerText);

    return result.lastInsertRowid;
}

module.exports = {
    createTriggerText
};