const Database = require('better-sqlite3');
const paths = require('../config/paths');

const db = new Database(paths.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('temp_store = MEMORY');
db.pragma('busy_timeout = 5000');

console.log('Aura database connected.');

module.exports = db;
