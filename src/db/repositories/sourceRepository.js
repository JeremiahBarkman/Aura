const db = require('../connection');

function createSourceItem(sourceType, rawText, sourcePath = null, durationMs = null, language = null) {
    const stmt = db.prepare(`
        INSERT INTO source_items (
            source_type,
            raw_text,
            source_path,
            duration_ms,
            language
        )
        VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
        sourceType,
        rawText,
        sourcePath,
        durationMs,
        language
    );

    return result.lastInsertRowid;
}

function getAllSourceItems() {
    const stmt = db.prepare(`
        SELECT *
        FROM source_items
        ORDER BY created_at DESC
    `);

    return stmt.all();
}

function getSourceItemById(id) {
    const stmt = db.prepare(`
        SELECT *
        FROM source_items
        WHERE id = ?
    `);

    return stmt.get(id);
}

module.exports = {
    createSourceItem,
    getAllSourceItems,
    getSourceItemById
};