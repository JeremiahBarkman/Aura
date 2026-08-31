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

-- One Aura Conference recording session. Audio is captured as a series of
-- short chunks during the meeting; everything downstream (transcription,
-- topic extraction, record generation) runs after recording stops so a live
-- call never competes with Whisper/Ollama/ComfyUI for the GPU.
--
-- transcript/language/error are unused while only recording exists, but are
-- declared now on purpose: Aura has no migration framework, so a column added
-- to this table later would need an ad-hoc ensureColumn() call in server.js.
-- Declaring them up front keeps that out of the codebase entirely.
CREATE TABLE IF NOT EXISTS conferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'recording',
    transcript TEXT,
    duration_ms INTEGER,
    language TEXT,
    group_id INTEGER,
    error TEXT,
    -- The meeting-level source_text object from the extraction model: the
    -- archival summary plus key points, decisions, action items, open
    -- questions and keywords. Stored whole rather than split into columns
    -- because Aura displays it and does not query into it.
    source_text_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (group_id)
        REFERENCES library_groups(id)
);

-- One audio file per recording chunk, in capture order.
--
-- The recorder restarts every few minutes rather than writing one long file,
-- so each row points at an independently valid .webm that Whisper can accept
-- on its own. That keeps any single transcription request short, and means a
-- crash mid-meeting costs one chunk instead of the whole session.
--
-- duration_ms is measured by the browser while recording. MediaRecorder
-- routinely omits duration from the WebM header, so probing the file after
-- the fact is unreliable -- the capturing side is the only place that knows.
CREATE TABLE IF NOT EXISTS conference_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conference_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    audio_path TEXT NOT NULL,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (conference_id)
        REFERENCES conferences(id)
        ON DELETE CASCADE
);

-- One subject of discussion extracted from a conference transcript.
--
-- The extraction model returns considerably more per subject than Aura
-- dispatches (style tags, shot type, span markers, entities, search intent and
-- rejection hints). The fields Aura acts on or displays are columns; raw_json
-- keeps the whole subject object so nothing is lost to a column list written
-- before the dispatch step exists.
--
-- Topics point forward to source_items rather than the other way round, so a
-- generated draft record is an ordinary Aura record with no conference-shaped
-- columns bolted onto source_items.
CREATE TABLE IF NOT EXISTS conference_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conference_id INTEGER NOT NULL,
    subject_id TEXT,
    order_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    visual_concept TEXT,
    image_strategy TEXT NOT NULL DEFAULT 'none',
    positive_prompt TEXT,
    negative_prompt TEXT,
    search_query TEXT,
    alt_queries TEXT,
    original_trigger_text TEXT,
    cleaned_trigger_text TEXT,
    salience REAL,
    confidence REAL,
    is_sensitive INTEGER NOT NULL DEFAULT 0,
    is_approved INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    source_item_id INTEGER,
    raw_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (conference_id)
        REFERENCES conferences(id)
        ON DELETE CASCADE,

    FOREIGN KEY (source_item_id)
        REFERENCES source_items(id)
        ON DELETE SET NULL
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

-- Chunks are always read as a complete session in capture order.
CREATE INDEX IF NOT EXISTS idx_conference_chunks_conference
    ON conference_chunks(conference_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_conference_topics_conference
    ON conference_topics(conference_id, order_index);