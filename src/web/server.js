// ============================================================================
// Aura Local Web Server
// ============================================================================
// Purpose:
// - Hosts the Aura Control Panel, Aura Output Window, static assets, and local
//   API routes used by Record Mode, Play Mode, system status, and PsySeg config.
// - Keeps the current MVP local-first by binding to the local Electron/Node app.
//
// Important boundaries:
// - This file should orchestrate routes only.
// - Business logic should remain in services/repositories where possible.
// - Secrets should continue to come from .env via dotenv, never frontend source.
// ============================================================================

// -----------------------------------------------------------------------------
// Environment and Module Imports
// -----------------------------------------------------------------------------

require('dotenv').config();

const AdmZip = require('adm-zip');
const express = require('express');

const fs = require('fs');

const path = require('path');
const multer = require('multer');

const db = require('../db/connection');
const paths = require('../config/paths');
const recordModeService = require('../record/recordModeService');

const playModeService = require('../play/playModeService');

const SceneSlotManager = require('../play/SceneSlotManager');

const auraConfig = require('../config/auraConfig');

const createSystemRoutes = require('./routes/systemRoutes');

const createPlayRoutes = require('./routes/playRoutes');

// -----------------------------------------------------------------------------
// Express Application State
// -----------------------------------------------------------------------------
const app = express();
const port = Number(process.env.PORT) || 5150;

// Active scene state is intentionally in-memory for the MVP.
// Future multi-window or packaged builds may need a stronger shared-state layer.
const sceneState = {
    activeAuraScene: null
};

const sceneSlotManager = new SceneSlotManager();

// -----------------------------------------------------------------------------
// Upload Storage Configuration
// -----------------------------------------------------------------------------
const audioStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, paths.audioDir);
    },
    filename: function (req, file, cb) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        cb(null, `recording-${timestamp}.webm`);
    }
});

const upload = multer({ storage: audioStorage });

const manualImageStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, path.join(paths.imagesDir, 'manual'));
    },
    filename: function (req, file, cb) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = path.extname(file.originalname) || '.png';
        cb(null, `manual-image-${timestamp}${ext}`);
    }
});

const manualImageUpload = multer({ storage: manualImageStorage });

const importPackageStorage = multer.diskStorage({
    destination: function (req, file, cb) {
        const importDir = path.join(paths.dataDir || path.join(__dirname, '../../data'), 'imports');

        fs.mkdirSync(importDir, {
            recursive: true
        });

        cb(null, importDir);
    },
    filename: function (req, file, cb) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        cb(null, `aura-import-${timestamp}.zip`);
    }
});

const importPackageUpload = multer({
    storage: importPackageStorage
});

// -----------------------------------------------------------------------------
// Database Schema Initialization
// -----------------------------------------------------------------------------
const schema = fs.readFileSync(paths.schemaPath, 'utf8');

db.exec(schema);

// CREATE TABLE IF NOT EXISTS is a no-op against a table that already exists
// with an older structure, so columns added to existing tables need an
// explicit migration rather than relying on schema.sql alone.
function ensureColumn(table, column, definition) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!existing.some((col) => col.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

ensureColumn('source_items', 'group_id', 'INTEGER');
ensureColumn('source_items', 'language', 'TEXT');
ensureColumn('generated_images', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('generated_images', 'is_favorite', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('generated_images', 'deleted_at', 'TEXT');

for (const dir of [paths.audioDir, path.join(paths.imagesDir, 'manual'), path.join(paths.imagesDir, 'imports'), paths.generatedImagesDir, paths.backgroundsDir, paths.importsDir]) {
    fs.mkdirSync(dir, { recursive: true });
}

// -----------------------------------------------------------------------------
// Static Middleware
// -----------------------------------------------------------------------------
// Generated images are copied into Aura's own storage at generation time
// (see comfyUiService.persistGeneratedImageToStorage), so serve them from
// there rather than ComfyUI's volatile external output folder.
app.use('/generated-images', express.static(paths.generatedImagesDir));
app.use('/manual-images', express.static(path.join(paths.imagesDir, 'manual')));
app.use('/imported-images', express.static(path.join(paths.imagesDir, 'imports')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '25mb' }));
app.use('/node_modules', express.static(path.join(paths.projectRoot, 'node_modules')));
app.use(express.static(path.join(paths.projectRoot, 'public')));

// API responses reflect live, frequently-changing local data (records,
// groups, system status). Without this, Chromium's default GET caching can
// serve a stale response on repeat visits -- including, worst case, an
// error response cached from an early request before the server was fully
// ready, persisting even after the underlying problem is gone.
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

app.use(createSystemRoutes({
    db,
    auraConfig
}));

app.use(createPlayRoutes({
    playModeService,
    sceneSlotManager,
    sceneState
}));

// -----------------------------------------------------------------------------
// Record Mode Routes
// -----------------------------------------------------------------------------
function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

app.post('/record/text', async (req, res) => {
    const rawText = req.body.rawText;

    if (!rawText || rawText.trim().length === 0) {
        return res.status(400).send('Text is required.');
    }

    const result = await recordModeService.ingestManualText(rawText.trim());

res.send(`
    <h1>Text Saved</h1>
    <p>Saved source item ID: ${escapeHtml(result.sourceItemId)}</p>

    <h2>Summary</h2>
    <pre>${escapeHtml(result.textProducts.summaryText)}</pre>

    <h2>Image Prompt</h2>
    <pre>${escapeHtml(result.textProducts.imagePrompt)}</pre>

    <h2>Cleaned Trigger Text</h2>
    <pre>${escapeHtml(result.textProducts.cleanedTriggerText)}</pre>

    <a href="/">Add more text</a>
`);

});

// -----------------------------------------------------------------------------
// Source Item Query Routes
// -----------------------------------------------------------------------------
app.get('/api/source-items/recent', (req, res) => {
    const items = db.prepare(`
        SELECT *
        FROM source_items
        ORDER BY id DESC
        LIMIT 10
    `).all();

    res.json(items);
});

app.post('/record/audio', upload.single('audio'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'Audio file is required.'
            });
        }

        const audioPath =
            path.join(paths.audioDir, req.file.filename);

        const result =
            await recordModeService.ingestAudioFile(audioPath);

        res.json({
            success: true,
            message: 'Audio recorded, transcribed, processed, and saved.',
            audioPath,
            sourceItemId: result.sourceItemId,
            transcript: result.transcript,
            durationMs: result.durationMs,
            textProducts: result.textProducts
        });

    } catch (error) {
        console.error('Audio record save failed:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// -----------------------------------------------------------------------------
// Full Record Review Route
// -----------------------------------------------------------------------------
app.get('/api/records/full', (req, res) => {
    const view = String(req.query.view || 'all-complete');

    const rawGroupId = req.query.groupId;

    const groupId =
        rawGroupId === null ||
        rawGroupId === undefined ||
        rawGroupId === ''
            ? null
            : Number(rawGroupId);

    // The record limit must apply BEFORE the image join: a LIMIT on the
    // joined result counts rows (one per image), so a plain LIMIT 500 both
    // returns fewer than 500 records and can truncate the last record's
    // image list mid-record. Limit source_items in a subquery instead.
    let recordFilter = '';

    const params = [];

    if (groupId !== null) {
        recordFilter = 'WHERE group_id = ?';
        params.push(groupId);
    } else if (view === 'all-complete') {
        recordFilter = `WHERE record_status = 'complete'`;
    } else if (view === 'all-drafts') {
        recordFilter = `WHERE record_status IS NULL OR record_status != 'complete'`;
    } else if (view === 'all-records') {
        // no filter
    }

    const sql = `
        SELECT
            si.id AS source_item_id,
            si.source_type,
            si.raw_text,
            si.source_path,
            si.duration_ms,
            si.record_status,
            si.group_id,
            si.primary_image_id,
            si.created_at,

            s.id AS summary_id,
            s.summary_text,
            s.image_prompt,
            s.model_used,

            tt.original_trigger_text,
            tt.cleaned_trigger_text,

            gi.id AS generated_image_id,
            gi.image_path,
            gi.prompt_id,
            gi.workflow_name,
            gi.is_active,
            gi.is_favorite,
            gi.deleted_at

        FROM (
            SELECT *
            FROM source_items
            ${recordFilter}
            ORDER BY id DESC
            LIMIT 500
        ) si

        LEFT JOIN summaries s
            ON s.source_item_id = si.id

        LEFT JOIN trigger_texts tt
            ON tt.source_item_id = si.id

        LEFT JOIN generated_images gi
            ON gi.source_item_id = si.id
            AND gi.deleted_at IS NULL

        ORDER BY si.id DESC, gi.id DESC
    `;

    const rows = db.prepare(sql).all(...params);

    const recordsById = new Map();

    for (const row of rows) {
        if (!recordsById.has(row.source_item_id)) {
            recordsById.set(row.source_item_id, {
                source_item_id: row.source_item_id,
                source_type: row.source_type,
                raw_text: row.raw_text,
                source_path: row.source_path,
                duration_ms: row.duration_ms,
                record_status: row.record_status,
                group_id: row.group_id,
                primary_image_id: row.primary_image_id,
                created_at: row.created_at,
                summary_id: row.summary_id,
                summary_text: row.summary_text,
                image_prompt: row.image_prompt,
                model_used: row.model_used,
                original_trigger_text: row.original_trigger_text,
                cleaned_trigger_text: row.cleaned_trigger_text,
                images: []
            });
        }

        if (row.generated_image_id) {
            recordsById.get(row.source_item_id).images.push({
                generated_image_id: row.generated_image_id,
                image_path: row.image_path,
                prompt_id: row.prompt_id,
                workflow_name: row.workflow_name,
                is_active: row.is_active,
                is_favorite: row.is_favorite
            });
        }
    }

    res.json(Array.from(recordsById.values()));
});

// -----------------------------------------------------------------------------
// Record Editing Routes
// -----------------------------------------------------------------------------
app.patch('/api/source-items/:id/raw-text', (req, res) => {
    const id = Number(req.params.id);
    const value = req.body.value;

    if (!value || value.trim().length === 0) {
        return res.status(400).json({ error: 'raw_text cannot be empty.' });
    }

    db.prepare(`
        UPDATE source_items
        SET raw_text = ?
        WHERE id = ?
    `).run(value.trim(), id);

    res.json({ success: true });
});

app.patch('/api/summaries/:sourceItemId/summary-text', (req, res) => {
    const sourceItemId = Number(req.params.sourceItemId);
    const value = req.body.value || '';

    db.prepare(`
        UPDATE summaries
        SET summary_text = ?
        WHERE source_item_id = ?
    `).run(value.trim(), sourceItemId);

    res.json({ success: true });
});

app.patch('/api/summaries/:sourceItemId/image-prompt', (req, res) => {
    const sourceItemId = Number(req.params.sourceItemId);
    const value = req.body.value || '';

    db.prepare(`
        UPDATE summaries
        SET image_prompt = ?
        WHERE source_item_id = ?
    `).run(value.trim(), sourceItemId);

    res.json({ success: true });
});

app.patch('/api/trigger-texts/:sourceItemId/cleaned-trigger-text', (req, res) => {
    const sourceItemId = Number(req.params.sourceItemId);
    const value = req.body.value || '';

    db.prepare(`
        UPDATE trigger_texts
        SET cleaned_trigger_text = ?
        WHERE source_item_id = ?
    `).run(value.trim(), sourceItemId);

    // The cached trigger embedding no longer matches the edited text;
    // Play Mode re-embeds lazily on the next match.
    playModeService.invalidateEmbedding(sourceItemId);

    res.json({ success: true });
});

// -----------------------------------------------------------------------------
// Manual Record/Image Upload Routes
// -----------------------------------------------------------------------------
app.post('/record/manual', manualImageUpload.single('image'), (req, res) => {
    const {
        rawText,
        summaryText,
        imagePrompt,
        cleanedTriggerText
    } = req.body;

    if (!rawText || !summaryText || !imagePrompt || !cleanedTriggerText) {
        return res.status(400).json({
            error: 'rawText, summaryText, imagePrompt, and cleanedTriggerText are required.'
        });
    }

    const status = req.file ? 'complete' : 'needs_image';

    const sourceResult = db.prepare(`
        INSERT INTO source_items (
            source_type,
            raw_text,
            source_path,
            duration_ms,
            record_status
        )
        VALUES (?, ?, ?, ?, ?)
    `).run(
        'manual_record',
        rawText.trim(),
        null,
        null,
        status
    );

    const sourceItemId = sourceResult.lastInsertRowid;

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
        summaryText.trim(),
        imagePrompt.trim(),
        'manual'
    );

    const summaryId = summaryResult.lastInsertRowid;

    db.prepare(`
        INSERT INTO trigger_texts (
            source_item_id,
            original_trigger_text,
            cleaned_trigger_text
        )
        VALUES (?, ?, ?)
    `).run(
        sourceItemId,
        cleanedTriggerText.trim(),
        cleanedTriggerText.trim()
    );

    let generatedImageId = null;
    let imagePath = null;

    if (req.file) {
        imagePath = path.join(paths.imagesDir, 'manual', req.file.filename);

        const imageResult = db.prepare(`
            INSERT INTO generated_images (
                source_item_id,
                summary_id,
                image_path,
                prompt_id,
                workflow_name,
                model_used
            )
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            sourceItemId,
            summaryId,
            imagePath,
            null,
            'manual_upload',
            'manual'
        );

        generatedImageId = imageResult.lastInsertRowid;

        const sourceRecord = db.prepare(`
            SELECT primary_image_id
            FROM source_items
            WHERE id = ?
        `).get(sourceItemId);

        if (!sourceRecord.primary_image_id) {
            db.prepare(`
                UPDATE source_items
                SET primary_image_id = ?
                WHERE id = ?
            `).run(
                generatedImageId,
                sourceItemId
            );
        }
    }

    res.json({
        success: true,
        sourceItemId,
        summaryId,
        generatedImageId,
        imagePath,
        recordStatus: status
    });
});

app.post('/api/source-items/:id/images/upload', manualImageUpload.single('image'), (req, res) => {
    const sourceItemId = Number(req.params.id);

    if (!req.file) {
        return res.status(400).json({ error: 'Image file is required.' });
    }

    const summary = db.prepare(`
        SELECT id
        FROM summaries
        WHERE source_item_id = ?
        ORDER BY id DESC
        LIMIT 1
    `).get(sourceItemId);

    const imagePath = path.join(paths.imagesDir, 'manual', req.file.filename);

    const result = db.prepare(`
        INSERT INTO generated_images (
            source_item_id,
            summary_id,
            image_path,
            prompt_id,
            workflow_name,
            model_used
        )
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        sourceItemId,
        summary ? summary.id : null,
        imagePath,
        null,
        'manual_upload_existing_record',
        'manual'
    );

    db.prepare(`
        UPDATE source_items
        SET record_status = 'complete'
        WHERE id = ?
    `).run(sourceItemId);

    const sourceRecord = db.prepare(`
        SELECT primary_image_id
        FROM source_items
        WHERE id = ?
    `).get(sourceItemId);

    if (!sourceRecord.primary_image_id) {
        db.prepare(`
            UPDATE source_items
            SET primary_image_id = ?
            WHERE id = ?
        `).run(
            result.lastInsertRowid,
            sourceItemId
        );
    }

    res.json({
        success: true,
        sourceItemId,
        generatedImageId: result.lastInsertRowid,
        imagePath
    });
});

// -----------------------------------------------------------------------------
// Image Ownership / Record Reassignment Routes
// -----------------------------------------------------------------------------
// Moves an existing generated image from one source record to another.
// This does not copy or modify the image file. It only updates DB ownership.
app.post('/api/generated-images/:id/move', (req, res) => {
    const imageId = Number(req.params.id);
    const destinationSourceItemId = Number(req.body.destinationSourceItemId);

    if (!imageId || !destinationSourceItemId) {
        return res.status(400).json({
            success: false,
            error: 'Valid image id and destination source item id are required.'
        });
    }

    const image = db.prepare(`
        SELECT id, source_item_id
        FROM generated_images
        WHERE id = ?
          AND deleted_at IS NULL
    `).get(imageId);

    if (!image) {
        return res.status(404).json({
            success: false,
            error: 'Image not found or has been deleted.'
        });
    }

    const destinationRecord = db.prepare(`
        SELECT id
        FROM source_items
        WHERE id = ?
    `).get(destinationSourceItemId);

    if (!destinationRecord) {
        return res.status(404).json({
            success: false,
            error: 'Destination record not found.'
        });
    }

    db.prepare(`
        UPDATE generated_images
        SET source_item_id = ?
        WHERE id = ?
    `).run(destinationSourceItemId, imageId);

    // The source record may still point at the moved image as its primary.
    // Left stale, Play Mode would keep showing an image that now belongs to
    // a different record. Reassign to another remaining image, or clear it.
    const sourceRecord = db.prepare(`
        SELECT primary_image_id
        FROM source_items
        WHERE id = ?
    `).get(image.source_item_id);

    if (sourceRecord && sourceRecord.primary_image_id === imageId) {
        const replacement = db.prepare(`
            SELECT id
            FROM generated_images
            WHERE source_item_id = ?
              AND deleted_at IS NULL
            ORDER BY id ASC
            LIMIT 1
        `).get(image.source_item_id);

        db.prepare(`
            UPDATE source_items
            SET primary_image_id = ?
            WHERE id = ?
        `).run(replacement ? replacement.id : null, image.source_item_id);
    }

    const remainingImageCount = db.prepare(`
        SELECT COUNT(*) AS count
        FROM generated_images
        WHERE source_item_id = ?
        AND deleted_at IS NULL
    `).get(image.source_item_id);

    let sourceRecordMovedToDraft = false;

    if (remainingImageCount.count === 0) {
        db.prepare(`
            UPDATE source_items
            SET record_status = 'draft'
            WHERE id = ?
        `).run(image.source_item_id);

        sourceRecordMovedToDraft = true;
    }

    res.json({
        success: true,
        imageId,
        previousSourceItemId: image.source_item_id,
        destinationSourceItemId,
        sourceRecordMovedToDraft
    });
});

// -----------------------------------------------------------------------------
// Delete/Soft-Delete Routes
// -----------------------------------------------------------------------------
// Deletes a full Aura source record and its dependent DB rows.
// This intentionally removes metadata rows first to avoid foreign-key failures.
app.delete('/api/source-items/:id', (req, res) => {
    const sourceItemId = Number(req.params.id);

    if (!sourceItemId) {
        return res.status(400).json({
            success: false,
            error: 'Valid source item id is required.'
        });
    }

    try {
        const deleteRecord = db.transaction(() => {
            db.prepare(`
                DELETE FROM image_search_imports
                WHERE source_item_id = ?
            `).run(sourceItemId);

            db.prepare(`
                DELETE FROM source_items
                WHERE id = ?
            `).run(sourceItemId);
        });

        deleteRecord();

        res.json({
            success: true,
            sourceItemId
        });

    } catch (error) {
        console.error('Delete source item failed:', error);

        res.status(500).json({
            success: false,
            sourceItemId,
            error: error.message
        });
    }
});

app.delete('/api/generated-images/:id', (req, res) => {
    const imageId = Number(req.params.id);

    const image = db.prepare(`
        SELECT source_item_id
        FROM generated_images
        WHERE id = ?
    `).get(imageId);

    db.prepare(`
        UPDATE generated_images
        SET deleted_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(imageId);

    let sourceRecordMovedToDraft = false;

    if (image) {
        // If this was the record's primary image, hand primary to another
        // remaining active image (or clear it) so nothing points at a
        // deleted image.
        const sourceRecord = db.prepare(`
            SELECT primary_image_id
            FROM source_items
            WHERE id = ?
        `).get(image.source_item_id);

        const replacement = db.prepare(`
            SELECT id
            FROM generated_images
            WHERE source_item_id = ?
              AND deleted_at IS NULL
            ORDER BY id ASC
            LIMIT 1
        `).get(image.source_item_id);

        if (sourceRecord && sourceRecord.primary_image_id === imageId) {
            db.prepare(`
                UPDATE source_items
                SET primary_image_id = ?
                WHERE id = ?
            `).run(replacement ? replacement.id : null, image.source_item_id);
        }

        // A complete record requires at least one active image; without
        // one it must fall back to draft (mirrors the move route).
        if (!replacement) {
            db.prepare(`
                UPDATE source_items
                SET record_status = 'draft'
                WHERE id = ?
                  AND record_status = 'complete'
            `).run(image.source_item_id);

            sourceRecordMovedToDraft = true;
        }
    }

    res.json({ success: true, imageId, sourceRecordMovedToDraft });
});



// -----------------------------------------------------------------------------
// Draft/Complete Workflow Route
// -----------------------------------------------------------------------------
app.patch('/api/source-items/:id/complete', (req, res) => {
    const sourceItemId = Number(req.params.id);

    const record = db.prepare(`
        SELECT
            si.id,
            si.raw_text,
            s.summary_text,
            s.image_prompt,
            tt.cleaned_trigger_text,
            COUNT(gi.id) AS active_image_count
        FROM source_items si
        LEFT JOIN summaries s
            ON s.source_item_id = si.id
        LEFT JOIN trigger_texts tt
            ON tt.source_item_id = si.id
        LEFT JOIN generated_images gi
            ON gi.source_item_id = si.id
            AND gi.deleted_at IS NULL
        WHERE si.id = ?
        GROUP BY si.id
    `).get(sourceItemId);

    if (!record) {
        return res.status(404).json({ error: 'Record not found.' });
    }

    const missingFields = [];

    if (!record.raw_text || !record.raw_text.trim()) {
        missingFields.push('Original Source Text');
    }

    if (!record.summary_text || !record.summary_text.trim()) {
        missingFields.push('Image Summary');
    }

    if (!record.image_prompt || !record.image_prompt.trim()) {
        missingFields.push('Image Prompt');
    }

    if (!record.cleaned_trigger_text || !record.cleaned_trigger_text.trim()) {
        missingFields.push('Cleaned Play Mode Trigger Text');
    }

    if (!record.active_image_count) {
        missingFields.push('At least one active image');
    }

    if (missingFields.length > 0) {
        return res.status(400).json({
            error: 'Record is not complete.',
            missingFields
        });
    }

    db.prepare(`
        UPDATE source_items
        SET record_status = 'complete'
        WHERE id = ?
    `).run(sourceItemId);

    res.json({
        success: true,
        sourceItemId,
        recordStatus: 'complete'
    });
});


// -----------------------------------------------------------------------------
// Maintenance: Trash (Soft-Deleted Images)
// -----------------------------------------------------------------------------
// Lists soft-deleted images so they can be reviewed and restored before a
// permanent purge.
app.get('/api/db-manager/trash', (req, res) => {
    const rows = db.prepare(`
        SELECT
            gi.id,
            gi.image_path,
            gi.workflow_name,
            gi.deleted_at,
            gi.source_item_id,
            si.record_status,
            substr(si.raw_text, 1, 100) AS raw_text_snippet
        FROM generated_images gi
        LEFT JOIN source_items si
            ON si.id = gi.source_item_id
        WHERE gi.deleted_at IS NOT NULL
        ORDER BY gi.deleted_at DESC
        LIMIT 500
    `).all();

    res.json(rows);
});

app.post('/api/generated-images/:id/restore', (req, res) => {
    const imageId = Number(req.params.id);

    const image = db.prepare(`
        SELECT id, source_item_id
        FROM generated_images
        WHERE id = ?
          AND deleted_at IS NOT NULL
    `).get(imageId);

    if (!image) {
        return res.status(404).json({
            success: false,
            error: 'Image not found in trash.'
        });
    }

    db.prepare(`
        UPDATE generated_images
        SET deleted_at = NULL
        WHERE id = ?
    `).run(imageId);

    // If the parent record lost its primary when this image was deleted,
    // hand primary back to the restored image. Record status is left
    // alone -- restoring an image doesn't imply the record is complete.
    const sourceRecord = db.prepare(`
        SELECT primary_image_id
        FROM source_items
        WHERE id = ?
    `).get(image.source_item_id);

    if (sourceRecord && !sourceRecord.primary_image_id) {
        db.prepare(`
            UPDATE source_items
            SET primary_image_id = ?
            WHERE id = ?
        `).run(imageId, image.source_item_id);
    }

    res.json({
        success: true,
        imageId,
        sourceItemId: image.source_item_id
    });
});

// -----------------------------------------------------------------------------
// Maintenance: Purge Soft-Deleted Images
// -----------------------------------------------------------------------------
// Soft-deleted images (deleted_at set) keep their rows and files forever
// otherwise. This permanently removes the rows and unlinks each file --
// but only when no surviving row still references the same path (moved/
// reassigned images can share files).
app.post('/api/db-manager/purge-deleted', (req, res) => {
    try {
        const deletedImages = db.prepare(`
            SELECT id, image_path
            FROM generated_images
            WHERE deleted_at IS NOT NULL
        `).all();

        let filesRemoved = 0;

        for (const image of deletedImages) {
            if (!image.image_path) {
                continue;
            }

            const stillReferenced = db.prepare(`
                SELECT COUNT(*) AS count
                FROM generated_images
                WHERE image_path = ?
                  AND deleted_at IS NULL
            `).get(image.image_path);

            if (stillReferenced.count > 0) {
                continue;
            }

            try {
                if (fs.existsSync(image.image_path)) {
                    fs.unlinkSync(image.image_path);
                    filesRemoved++;
                }
            } catch (fileError) {
                console.warn(
                    `Purge: could not remove file ${image.image_path}:`,
                    fileError.message
                );
            }
        }

        const result = db.prepare(`
            DELETE FROM generated_images
            WHERE deleted_at IS NOT NULL
        `).run();

        res.json({
            success: true,
            purgedRows: result.changes,
            filesRemoved
        });

    } catch (error) {
        console.error('Purge deleted images failed:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// -----------------------------------------------------------------------------
// DB Manager Routes
// -----------------------------------------------------------------------------
app.get('/api/db-manager/stats', (req, res) => {
    const totalRecords = db.prepare(`
        SELECT COUNT(*) AS count
        FROM source_items
    `).get().count;

    const completeRecords = db.prepare(`
        SELECT COUNT(*) AS count
        FROM source_items
        WHERE record_status = 'complete'
    `).get().count;

    const draftRecords = db.prepare(`
        SELECT COUNT(*) AS count
        FROM source_items
        WHERE record_status IS NULL OR record_status != 'complete'
    `).get().count;

    const groups = db.prepare(`
        SELECT COUNT(*) AS count
        FROM library_groups
    `).get().count;

    const images = db.prepare(`
        SELECT COUNT(*) AS count
        FROM generated_images
        WHERE deleted_at IS NULL
    `).get().count;

    res.json({
        totalRecords,
        completeRecords,
        draftRecords,
        groups,
        images
    });
});

app.get('/api/db-manager/records', (req, res) => {
    const rawGroupId = req.query.groupId;

    const groupId =
        rawGroupId === null ||
        rawGroupId === undefined ||
        rawGroupId === ''
            ? null
            : Number(rawGroupId);

    const whereClause =
        groupId === null
            ? ''
            : 'WHERE si.group_id = ?';

    const params =
        groupId === null
            ? []
            : [groupId];

    try {
        const rows = db.prepare(`
            SELECT
                si.id,
                si.source_type,
                si.record_status,
                si.group_id,
                si.primary_image_id,
                lg.name AS group_name,
                si.created_at,
                COUNT(gi.id) AS image_count,

                COALESCE(primary_gi.image_path, fallback_gi.image_path)
                    AS preview_image_path,

                COALESCE(primary_gi.workflow_name, fallback_gi.workflow_name)
                    AS preview_workflow_name

            FROM source_items si

            LEFT JOIN library_groups lg
                ON lg.id = si.group_id

            LEFT JOIN generated_images gi
                ON gi.source_item_id = si.id
                AND gi.deleted_at IS NULL

            LEFT JOIN generated_images primary_gi
                ON primary_gi.id = si.primary_image_id
                AND primary_gi.source_item_id = si.id
                AND primary_gi.deleted_at IS NULL

            LEFT JOIN generated_images fallback_gi
                ON fallback_gi.id = (
                    SELECT gi2.id
                    FROM generated_images gi2
                    WHERE gi2.source_item_id = si.id
                      AND gi2.deleted_at IS NULL
                    ORDER BY gi2.id ASC
                    LIMIT 1
                )

            ${whereClause}

            GROUP BY si.id

            ORDER BY si.id DESC

            LIMIT 1000
        `).all(...params);

        res.json(rows);

    } catch (error) {
        console.error('DB Manager records failed:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/api/db-manager/bulk/move', (req, res) => {
    const recordIds = Array.isArray(req.body.recordIds)
        ? req.body.recordIds.map(Number).filter(Boolean)
        : [];

    const rawGroupId = req.body.groupId;

    const groupId =
        rawGroupId === null ||
        rawGroupId === undefined ||
        rawGroupId === ''
            ? null
            : Number(rawGroupId);

    if (!recordIds.length) {
        return res.status(400).json({
            success: false,
            error: 'At least one record id is required.'
        });
    }

    const placeholders = recordIds.map(() => '?').join(',');

    db.prepare(`
        UPDATE source_items
        SET group_id = ?
        WHERE id IN (${placeholders})
    `).run(groupId, ...recordIds);

    res.json({
        success: true,
        movedCount: recordIds.length,
        groupId
    });
});

app.post('/api/db-manager/bulk/complete', (req, res) => {
    const recordIds = Array.isArray(req.body.recordIds)
        ? req.body.recordIds.map(Number).filter(Boolean)
        : [];

    if (!recordIds.length) {
        return res.status(400).json({
            success: false,
            error: 'At least one record id is required.'
        });
    }

    const completed = [];
    const skipped = [];

    const completeOneRecord = db.transaction((sourceItemId) => {
        const record = db.prepare(`
            SELECT
                si.id,
                si.raw_text,
                s.summary_text,
                s.image_prompt,
                tt.cleaned_trigger_text,
                COUNT(gi.id) AS active_image_count
            FROM source_items si
            LEFT JOIN summaries s
                ON s.source_item_id = si.id
            LEFT JOIN trigger_texts tt
                ON tt.source_item_id = si.id
            LEFT JOIN generated_images gi
                ON gi.source_item_id = si.id
                AND gi.deleted_at IS NULL
            WHERE si.id = ?
            GROUP BY si.id
        `).get(sourceItemId);

        if (!record) {
            skipped.push({
                sourceItemId,
                reason: 'Record not found.'
            });
            return;
        }

        const missingFields = [];

        if (!record.raw_text || !record.raw_text.trim()) {
            missingFields.push('Source Text');
        }

        if (!record.summary_text || !record.summary_text.trim()) {
            missingFields.push('Summary');
        }

        if (!record.image_prompt || !record.image_prompt.trim()) {
            missingFields.push('Prompt');
        }

        if (!record.cleaned_trigger_text || !record.cleaned_trigger_text.trim()) {
            missingFields.push('Trigger Text');
        }

        if (!record.active_image_count) {
            missingFields.push('At least one active image');
        }

        if (missingFields.length) {
            skipped.push({
                sourceItemId,
                reason: `Missing: ${missingFields.join(', ')}`
            });
            return;
        }

        db.prepare(`
            UPDATE source_items
            SET record_status = 'complete'
            WHERE id = ?
        `).run(sourceItemId);

        completed.push(sourceItemId);
    });

    for (const sourceItemId of recordIds) {
        completeOneRecord(sourceItemId);
    }

    res.json({
        success: true,
        requestedCount: recordIds.length,
        completedCount: completed.length,
        skippedCount: skipped.length,
        completed,
        skipped
    });
});

app.post('/api/db-manager/bulk/delete', (req, res) => {
    const recordIds = Array.isArray(req.body.recordIds)
        ? req.body.recordIds.map(Number).filter(Boolean)
        : [];

    if (!recordIds.length) {
        return res.status(400).json({
            success: false,
            error: 'At least one record id is required.'
        });
    }

    try {
        const deleted = [];

        const deleteOneRecord = db.transaction((sourceItemId) => {
            db.prepare(`
                DELETE FROM image_search_imports
                WHERE source_item_id = ?
            `).run(sourceItemId);

            db.prepare(`
                DELETE FROM source_items
                WHERE id = ?
            `).run(sourceItemId);

            deleted.push(sourceItemId);
        });

        for (const sourceItemId of recordIds) {
            deleteOneRecord(sourceItemId);
        }

        res.json({
            success: true,
            deletedCount: deleted.length,
            deleted
        });

    } catch (error) {
        console.error('Bulk delete failed:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.delete('/api/db-manager/groups/:id', (req, res) => {
    const groupId = Number(req.params.id);

    if (!groupId) {
        return res.status(400).json({
            success: false,
            error: 'Valid group id is required.'
        });
    }

    try {
        const deleteGroupOnly = db.transaction(() => {
            db.prepare(`
                UPDATE source_items
                SET group_id = NULL
                WHERE group_id = ?
            `).run(groupId);

            const result = db.prepare(`
                DELETE FROM library_groups
                WHERE id = ?
            `).run(groupId);

            if (result.changes === 0) {
                throw new Error('Group not found.');
            }
        });

        deleteGroupOnly();

        res.json({
            success: true,
            groupId
        });

    } catch (error) {
        console.error('Delete group failed:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/api/db-manager/export/selected', (req, res) => {
    try {
        const recordIds = Array.isArray(req.body.recordIds)
            ? req.body.recordIds.map(Number).filter(Boolean)
            : [];

        if (!recordIds.length) {
            return res.status(400).json({
                success: false,
                error: 'At least one record id is required.'
            });
        }

        const placeholders = recordIds.map(() => '?').join(',');

        const records = db.prepare(`
            SELECT
                si.*,
                lg.name AS group_name,
                lg.description AS group_description
            FROM source_items si
            LEFT JOIN library_groups lg
                ON lg.id = si.group_id
            WHERE si.id IN (${placeholders})
            ORDER BY si.id ASC
        `).all(...recordIds);

        const summaries = db.prepare(`
            SELECT *
            FROM summaries
            WHERE source_item_id IN (${placeholders})
        `).all(...recordIds);

        const triggerTexts = db.prepare(`
            SELECT *
            FROM trigger_texts
            WHERE source_item_id IN (${placeholders})
        `).all(...recordIds);

        const images = db.prepare(`
            SELECT *
            FROM generated_images
            WHERE source_item_id IN (${placeholders})
              AND deleted_at IS NULL
        `).all(...recordIds);

        const zip = new AdmZip();

        zip.addFile(
            'manifest.json',
            Buffer.from(JSON.stringify({
                exportType: 'selected-records',
                exportedAt: new Date().toISOString(),
                recordCount: records.length,
                imageCount: images.length
            }, null, 2), 'utf8')
        );

        zip.addFile(
            'records.json',
            Buffer.from(JSON.stringify({
                records,
                summaries,
                triggerTexts,
                images
            }, null, 2), 'utf8')
        );

        for (const image of images) {
            if (!image.image_path || !fs.existsSync(image.image_path)) {
                continue;
            }

            const imageFileName = path.basename(image.image_path);

            zip.addLocalFile(
                image.image_path,
                'images',
                `${image.id}-${imageFileName}`
            );
        }

        const zipBuffer = zip.toBuffer();

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `aura-export-selected-${timestamp}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${fileName}"`
        );

        res.send(zipBuffer);

    } catch (error) {
        console.error('Export selected failed:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/api/db-manager/export/group', (req, res) => {
    try {
        const rawGroupId = req.body.groupId;

        const groupId =
            rawGroupId === null ||
            rawGroupId === undefined ||
            rawGroupId === ''
                ? null
                : Number(rawGroupId);

        if (!groupId) {
            return res.status(400).json({
                success: false,
                error: 'A group id is required.'
            });
        }

        const group = db.prepare(`
            SELECT *
            FROM library_groups
            WHERE id = ?
        `).get(groupId);

        if (!group) {
            return res.status(404).json({
                success: false,
                error: 'Group not found.'
            });
        }

        const records = db.prepare(`
            SELECT
                si.*,
                ? AS group_name,
                ? AS group_description
            FROM source_items si
            WHERE si.group_id = ?
            ORDER BY si.id ASC
        `).all(group.name, group.description, groupId);

        const recordIds =
            records.map(record => record.id);

        if (!recordIds.length) {
            return res.status(400).json({
                success: false,
                error: 'This group has no records to export.'
            });
        }

        const placeholders =
            recordIds.map(() => '?').join(',');

        const summaries = db.prepare(`
            SELECT *
            FROM summaries
            WHERE source_item_id IN (${placeholders})
        `).all(...recordIds);

        const triggerTexts = db.prepare(`
            SELECT *
            FROM trigger_texts
            WHERE source_item_id IN (${placeholders})
        `).all(...recordIds);

        const images = db.prepare(`
            SELECT *
            FROM generated_images
            WHERE source_item_id IN (${placeholders})
              AND deleted_at IS NULL
        `).all(...recordIds);

        const zip = new AdmZip();

        zip.addFile(
            'manifest.json',
            Buffer.from(JSON.stringify({
                exportType: 'group',
                exportedAt: new Date().toISOString(),
                group,
                recordCount: records.length,
                imageCount: images.length
            }, null, 2), 'utf8')
        );

        zip.addFile(
            'records.json',
            Buffer.from(JSON.stringify({
                group,
                records,
                summaries,
                triggerTexts,
                images
            }, null, 2), 'utf8')
        );

        for (const image of images) {
            if (!image.image_path || !fs.existsSync(image.image_path)) {
                continue;
            }

            const imageFileName =
                path.basename(image.image_path);

            zip.addLocalFile(
                image.image_path,
                'images',
                `${image.id}-${imageFileName}`
            );
        }

        const zipBuffer = zip.toBuffer();

        const safeGroupName =
            group.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();

        const timestamp =
            new Date().toISOString().replace(/[:.]/g, '-');

        const fileName =
            `aura-export-group-${safeGroupName}-${timestamp}.zip`;

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${fileName}"`
        );

        res.send(zipBuffer);

    } catch (error) {
        console.error('Export group failed:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});


/**
 * Sets the primary image for a source record.
 *
 * The primary image is used for:
 * - Library display preference
 * - DB Manager preview
 * - Play Mode image preference
 */
app.patch('/api/source-items/:id/primary-image', (req, res) => {
    const sourceItemId = Number(req.params.id);
    const generatedImageId = Number(req.body.generatedImageId);

    if (!sourceItemId || !generatedImageId) {
        return res.status(400).json({
            success: false,
            error: 'Valid source item id and generated image id are required.'
        });
    }

    const image = db.prepare(`
        SELECT id
        FROM generated_images
        WHERE id = ?
          AND source_item_id = ?
          AND deleted_at IS NULL
    `).get(generatedImageId, sourceItemId);

    if (!image) {
        return res.status(400).json({
            success: false,
            error: 'Image does not belong to this record or has been deleted.'
        });
    }

    db.prepare(`
        UPDATE source_items
        SET primary_image_id = ?
        WHERE id = ?
    `).run(generatedImageId, sourceItemId);

    res.json({
        success: true,
        sourceItemId,
        primaryImageId: generatedImageId
    });
});

/**
 * Updates the library group assignment for a source record.
 *
 * If groupId is null or empty:
 * - the record is removed from any specific group
 * - it remains available when "All Complete Records" is selected
 */
app.patch('/api/source-items/:id/group', (req, res) => {
    const sourceItemId = Number(req.params.id);

    const rawGroupId = req.body.groupId;

    const groupId =
        rawGroupId === null ||
        rawGroupId === undefined ||
        rawGroupId === ''
            ? null
            : Number(rawGroupId);

    db.prepare(`
        UPDATE source_items
        SET group_id = ?
        WHERE id = ?
    `).run(groupId, sourceItemId);

    res.json({
        success: true,
        sourceItemId,
        groupId
    });
});

/**
 * Temporary SerpAPI image search test endpoint.
 *
 * Purpose:
 * Verifies:
 * - SerpAPI connectivity
 * - API key validity
 * - image result normalization
 *
 * Example:
 * /api/import/image-search/test?q=moog&limit=5
 */
app.get('/api/import/image-search/test', async (req, res) => {
    try {
        const { searchImages } =
            require('../import/serpApiImageSearchService');

        const query =
            String(req.query.q || '').trim();

        const limit =
            Number(req.query.limit || 5);

        const results =
            await searchImages({
                query,
                limit
            });

        res.json({
            success: true,
            count: results.length,
            results
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Imports internet image-search results into Aura as draft records.
 *
 * Flow:
 * user query + group + batch size
 * → SerpAPI image search
 * → local image download
 * → draft source_items
 * → summaries
 * → trigger_texts
 * → generated_images
 * → image_search_imports metadata
 *
 * Important:
 * Imported records always remain DRAFT until reviewed.
 */
app.post('/api/import/image-search', async (req, res) => {
    try {
        const { searchImages } =
            require('../import/serpApiImageSearchService');

        const { importImageSearchResults } =
            require('../import/imageSearchImportService');

        const query =
            String(req.body.query || '').trim();

        const limit =
            Number(req.body.limit || 25);

        const rawGroupId =
            req.body.groupId;

        const groupId =
            rawGroupId === null ||
            rawGroupId === undefined ||
            rawGroupId === ''
                ? null
                : Number(rawGroupId);

        if (!query) {
            return res.status(400).json({
                error: 'Search query is required.'
            });
        }

        const results = await searchImages({
            query,
            limit
        });

        const imported = await importImageSearchResults({
            searchQuery: query,
            results,
            groupId
        });

        res.json({
            success: true,
            query,
            groupId,
            requestedLimit: limit,
            found: results.length,
            imported
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.post('/api/db-manager/import/package', importPackageUpload.single('package'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'Package file is required.'
            });
        }

        const zip = new AdmZip(req.file.path);

        const recordsEntry = zip.getEntry('records.json');

        if (!recordsEntry) {
            return res.status(400).json({
                success: false,
                error: 'records.json not found in package.'
            });
        }

        const packageData = JSON.parse(
            recordsEntry.getData().toString('utf8')
        );

        const sourceRecords = packageData.records || [];
        const summaries = packageData.summaries || [];
        const triggerTexts = packageData.triggerTexts || [];
        const images = packageData.images || [];
        const exportedGroup = packageData.group || null;

        if (!sourceRecords.length) {
            return res.status(400).json({
                success: false,
                error: 'Package contains no records.'
            });
        }

        let importedGroupId = null;
        let importedGroupName = null;

        if (exportedGroup && exportedGroup.name) {
    const originalGroupName = exportedGroup.name;
    const importDate = new Date().toISOString().slice(0, 10);

    let groupName = originalGroupName;

    const groupNameExists = (name) => {
        return db.prepare(`
            SELECT id
            FROM library_groups
            WHERE name = ?
        `).get(name);
    };

    if (groupNameExists(groupName)) {
        const baseName =
            `${originalGroupName} (Imported ${importDate})`;

        groupName = baseName;

        let counter = 2;

        while (groupNameExists(groupName)) {
            groupName = `${baseName} ${counter}`;
            counter++;
        }
    }

    const groupResult = db.prepare(`
        INSERT INTO library_groups (name, description)
        VALUES (?, ?)
    `).run(
        groupName,
        exportedGroup.description || ''
    );

    importedGroupId = groupResult.lastInsertRowid;
    importedGroupName = groupName;
}

        const oldToNewSourceItemIds = new Map();
        const oldToNewSummaryIds = new Map();

        const importImagesDir =
            path.join(paths.imagesDir, 'imports');

        fs.mkdirSync(importImagesDir, {
            recursive: true
        });

        let importedImageCount = 0;

        const importTransaction = db.transaction(() => {
            for (const record of sourceRecords) {
                const result = db.prepare(`
                    INSERT INTO source_items (
                        source_type,
                        raw_text,
                        source_path,
                        duration_ms,
                        record_status,
                        group_id
                    )
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(
                    record.source_type || 'imported_record',
                    record.raw_text || '',
                    record.source_path || null,
                    record.duration_ms || null,
                    record.record_status || 'draft',
                    importedGroupId
                );

                oldToNewSourceItemIds.set(
                    Number(record.id),
                    result.lastInsertRowid
                );
            }

            for (const summary of summaries) {
                const newSourceItemId =
                    oldToNewSourceItemIds.get(Number(summary.source_item_id));

                if (!newSourceItemId) {
                    continue;
                }

                const result = db.prepare(`
                    INSERT INTO summaries (
                        source_item_id,
                        summary_text,
                        image_prompt,
                        model_used
                    )
                    VALUES (?, ?, ?, ?)
                `).run(
                    newSourceItemId,
                    summary.summary_text || '',
                    summary.image_prompt || '',
                    summary.model_used || 'imported'
                );

                oldToNewSummaryIds.set(
                    Number(summary.id),
                    result.lastInsertRowid
                );
            }

            for (const triggerText of triggerTexts) {
                const newSourceItemId =
                    oldToNewSourceItemIds.get(Number(triggerText.source_item_id));

                if (!newSourceItemId) {
                    continue;
                }

                db.prepare(`
                    INSERT INTO trigger_texts (
                        source_item_id,
                        original_trigger_text,
                        cleaned_trigger_text
                    )
                    VALUES (?, ?, ?)
                `).run(
                    newSourceItemId,
                    triggerText.original_trigger_text || '',
                    triggerText.cleaned_trigger_text || ''
                );
            }

            for (const image of images) {
                const newSourceItemId =
                    oldToNewSourceItemIds.get(Number(image.source_item_id));

                if (!newSourceItemId) {
                    continue;
                }

                const imageEntry =
                    zip.getEntries().find(entry =>
                        entry.entryName.startsWith(`images/${image.id}-`)
                    );

                if (!imageEntry) {
                    continue;
                }

                const originalFileName =
                    path.basename(imageEntry.entryName)
                        .replace(`${image.id}-`, '');

                const importedFileName =
                    `package-${Date.now()}-${Math.random().toString(16).slice(2)}-${originalFileName}`;

                const importedImagePath =
                    path.join(importImagesDir, importedFileName);

                fs.writeFileSync(
                    importedImagePath,
                    imageEntry.getData()
                );

                const newSummaryId =
                    oldToNewSummaryIds.get(Number(image.summary_id)) || null;

                db.prepare(`
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
                    newSourceItemId,
                    newSummaryId,
                    importedImagePath,
                    image.prompt_id || null,
                    image.workflow_name || 'imported_package',
                    image.model_used || 'imported',
                    image.is_active || 0,
                    image.is_favorite || 0
                );

                importedImageCount++;
            }
        });

        importTransaction();

        res.json({
            success: true,
            importedRecords: sourceRecords.length,
            importedSummaries: summaries.length,
            importedTriggerTexts: triggerTexts.length,
            importedImages: importedImageCount,
            importedGroupId,
            importedGroupName
        });

    } catch (error) {
        console.error('Import package failed:', error);

        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// -----------------------------------------------------------------------------
// Server Startup (app.listen)
// -----------------------------------------------------------------------------
// Bind to loopback only. This server has no authentication and exposes
// destructive routes plus PsySeg credentials (/api/config/psyseg); listening
// on 0.0.0.0 would hand all of that to anyone on the local network.
const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Aura local web UI running at http://localhost:${port}`);
});

server.on('error', (error) => {
    console.error('Aura server error:', error);
});