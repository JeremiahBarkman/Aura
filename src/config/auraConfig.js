const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const configDir = path.join(paths.dataDir, 'config');
const configPath = path.join(configDir, 'aura-config.json');

const defaultConfig = Object.freeze({
    version: 1,
    cameraDeviceId: '',
    microphoneDeviceId: '',
    cameraMode: '',
    displayMode: 'single',
    transitionType: 'fade',
    transitionDurationMs: 1800,
    minimumDisplayMs: 3000,
    minimumMatchScore: 0.45,

    // Segmentation edge/blur controls (Webcam Live View sliders).
    // segmentationErode softens the segmentation edge (blur/remove/replace);
    // segmentationBlur is the background-blur strength (blur mode only).
    segmentationErode: 1,
    segmentationBlur: 39,

    activeLibraryGroupId: '',
    libraryView: 'all-complete',
    outputBroadcastIntervalMs: 66,

    // Play Mode: blend embedding-based semantic matching into trigger
    // matching (falls back to keyword-only when Ollama/the embed model
    // is unavailable).
    semanticMatchingEnabled: true,

    // Empty string means "use the OLLAMA_MODEL env var / built-in default".
    ollamaModel: '',

    // Empty string means "use the built-in default negative prompt".
    negativePrompt: '',

    // UI display language (ISO 639-1). Supported codes are defined in
    // public/i18n/translations.js; unknown values fall back to English.
    uiLanguage: 'en'
});

const allowedKeys = new Set(Object.keys(defaultConfig));

function ensureConfigFile() {
    fs.mkdirSync(configDir, { recursive: true });

    if (!fs.existsSync(configPath)) {
        writeConfig(defaultConfig);
    }
}

// Keys that were renamed. A config file written by an older build still
// carries the old name; read it once so the user's slider values survive the
// rename, then writeConfig persists them under the new name.
const renamedKeys = {
    psySegErode: 'segmentationErode',
    psySegBlur: 'segmentationBlur'
};

function normalizeConfig(candidateConfig = {}) {
    const normalized = { ...defaultConfig };

    for (const [oldKey, newKey] of Object.entries(renamedKeys)) {
        if (candidateConfig[newKey] === undefined && candidateConfig[oldKey] !== undefined) {
            normalized[newKey] = candidateConfig[oldKey];
        }
    }

    for (const key of allowedKeys) {
        if (candidateConfig[key] !== undefined) {
            normalized[key] = candidateConfig[key];
        }
    }

    normalized.version = defaultConfig.version;
    return normalized;
}

function readConfig() {
    ensureConfigFile();

    try {
        return normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
    } catch (error) {
        console.warn('[AURA CONFIG] Rebuilding default config.', error);
        return writeConfig(defaultConfig);
    }
}

function writeConfig(config) {
    fs.mkdirSync(configDir, { recursive: true });

    const normalized = normalizeConfig(config);

    fs.writeFileSync(
        configPath,
        JSON.stringify(normalized, null, 2),
        'utf8'
    );

    return normalized;
}

function updateConfig(patch = {}) {
    const currentConfig = readConfig();
    const acceptedPatch = {};

    for (const [key, value] of Object.entries(patch)) {
        if (allowedKeys.has(key)) {
            acceptedPatch[key] = value;
        }
    }

    return writeConfig({
        ...currentConfig,
        ...acceptedPatch
    });
}

module.exports = {
    configPath,
    defaultConfig,
    readConfig,
    updateConfig
};