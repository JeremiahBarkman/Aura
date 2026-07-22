const db = require('../connection');

function createGeneratedImage(
    sourceItemId,
    summaryId,
    imagePath,
    promptId,
    workflowName,
    modelUsed
) {
    const stmt = db.prepare(`
        INSERT INTO generated_images (
            source_item_id,
            summary_id,
            image_path,
            prompt_id,
            workflow_name,
            model_used
        )
        VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
        sourceItemId,
        summaryId,
        imagePath,
        promptId,
        workflowName,
        modelUsed
    );

    return result.lastInsertRowid;
}

module.exports = {
    createGeneratedImage
};