/**
 * db/connection.js
 * Single shared database connection for the app.
 * Import this wherever you need DB access.
 */

const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || './data/orders.db';

let _db = null;

function getDb() {
  if (!_db) {
    _db = new Database(path.resolve(DB_PATH));
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

module.exports = { getDb };
