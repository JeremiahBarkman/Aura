const fs = require('fs');
const Database = require('better-sqlite3');
const paths = require('../config/paths');

// better-sqlite3 refuses to create the database file if its parent
// directory is missing, and this module is the first thing to touch
// dataDir on a fresh checkout (server.js creates the other data
// subdirectories, but only after requiring this file).
fs.mkdirSync(paths.dataDir, { recursive: true });

const db = new Database(paths.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('temp_store = MEMORY');
db.pragma('busy_timeout = 5000');

console.log('Aura database connected.');

module.exports = db;
