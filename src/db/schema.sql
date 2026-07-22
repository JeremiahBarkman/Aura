CREATE TABLE IF NOT EXISTS source_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_type TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    source_path TEXT,
    duration_ms INTEGER,
    record_status TEXT NOT NULL DEFAULT 'draft',
    group_id INTEGER,
    primary_image_id INTEGER,
    language TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_item_id INTEGER NOT NULL,
    summary_text TEXT NOT NULL,
    image_prompt TEXT NOT NULL,
    model_used TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_item_id) REFERENCES source_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS trigger_texts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_item_id INTEGER NOT NULL,
    original_trigger_text TEXT NOT NULL,
    cleaned_trigger_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_item_id) REFERENCES source_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS generated_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_item_id INTEGER NOT NULL,
    summary_id INTEGER,
    image_path TEXT NOT NULL,
    prompt_id TEXT,
    workflow_name TEXT,
    model_used TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,

    FOREIGN KEY (source_item_id)
        REFERENCES source_items(id)
        ON DELETE CASCADE,

    FOREIGN KEY (summary_id)
        REFERENCES summaries(id)
        ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS library_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS image_search_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    source_item_id INTEGER,
    generated_image_id INTEGER,

    search_query TEXT NOT NULL,
    result_title TEXT,
    result_source TEXT,
    result_link TEXT,
    original_image_url TEXT,
    thumbnail_url TEXT,

    imported_at TEXT DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (source_item_id)
        REFERENCES source_items(id),

    FOREIGN KEY (generated_image_id)
        REFERENCES generated_images(id)
);

-- Cached embedding vector for each record's cleaned trigger text, used by
-- Play Mode semantic matching. embedding is a raw Float32Array buffer.
-- Rows are invalidated (deleted) when trigger text changes and re-created
-- lazily at match time.
CREATE TABLE IF NOT EXISTS trigger_embeddings (
    source_item_id INTEGER PRIMARY KEY,
    model TEXT NOT NULL,
    embedding BLOB NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (source_item_id)
        REFERENCES source_items(id)
        ON DELETE CASCADE
);

-- Every hot query path joins child tables on source_item_id (Library,
-- DB Manager previews, Play Mode matching), and the Library/DB Manager
-- filter on group/status. Without these, each join is a full table scan.
CREATE INDEX IF NOT EXISTS idx_summaries_source_item
    ON summaries(source_item_id);

CREATE INDEX IF NOT EXISTS idx_trigger_texts_source_item
    ON trigger_texts(source_item_id);

CREATE INDEX IF NOT EXISTS idx_generated_images_source_item
    ON generated_images(source_item_id);

CREATE INDEX IF NOT EXISTS idx_image_search_imports_source_item
    ON image_search_imports(source_item_id);

CREATE INDEX IF NOT EXISTS idx_source_items_group_status
    ON source_items(group_id, record_status);