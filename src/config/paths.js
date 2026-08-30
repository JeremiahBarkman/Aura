const path = require('path');

const projectRoot = path.join(__dirname, '../..');

// A packaged Electron app's own files live inside a read-only app.asar
// archive, so writable data can't stay relative to projectRoot the way it
// does when running from a checkout. electron-main.js sets AURA_DATA_DIR
// to app.getPath('userData') when packaged; unset (dev mode), this falls
// back to today's projectRoot/data behavior unchanged. schemaPath is a
// read-only bundled resource, not writable data, so it always stays under
// projectRoot regardless.
const dataRoot = process.env.AURA_DATA_DIR || path.join(projectRoot, 'data');

const paths = {
    projectRoot,
    dataDir: dataRoot,
    dbPath: path.join(dataRoot, 'aura.db'),
    audioDir: path.join(dataRoot, 'audio'),
    conferenceAudioDir: path.join(dataRoot, 'audio', 'conference'),
    imagesDir: path.join(dataRoot, 'images'),
    generatedImagesDir: path.join(dataRoot, 'images', 'generated'),
    backgroundsDir: path.join(dataRoot, 'images', 'backgrounds'),
    importsDir: path.join(dataRoot, 'imports'),
    schemaPath: path.join(projectRoot, 'src', 'db', 'schema.sql')
};

module.exports = paths;