/**
 * Database module - SQLite via sql.js (pure JavaScript, no native compilation)
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'wa-otp.db');
const DATA_DIR = path.join(__dirname, '..', 'data');

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = null;
let ready = false;

// Save database to file
function saveDB() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Auto-save every 30 seconds
setInterval(() => {
  if (ready) saveDB();
}, 30000);

// Initialize database
async function initDB() {
  const SQL = await initSqlJs();

  // Load existing database or create new
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS wa_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_name TEXT UNIQUE NOT NULL,
      phone TEXT,
      status TEXT DEFAULT 'disconnected',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS otp_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_name TEXT NOT NULL,
      sender TEXT,
      message TEXT,
      otp_code TEXT,
      app_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create default admin user if not exists
  const bcrypt = require('bcryptjs');
  const existingUser = db.exec("SELECT id FROM users WHERE username = 'admin'");
  if (!existingUser.length || !existingUser[0].values.length) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", ['admin', hash]);
    console.log('[DB] Default user created: admin / admin123');
  }

  saveDB();
  ready = true;
  console.log('[DB] Database initialized');
}

// Wrapper functions that mimic better-sqlite3 API
function prepare(sql) {
  return {
    run(...params) {
      db.run(sql, params);
      saveDB();
    },
    get(...params) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
      }
      stmt.free();
      return null;
    },
    all(...params) {
      const results = [];
      const stmt = db.prepare(sql);
      stmt.bind(params);
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      return results;
    }
  };
}

// Prepared statements (will be initialized after initDB)
let queries = {};

function setupQueries() {
  queries = {
    // Users
    getUser: prepare("SELECT * FROM users WHERE username = ?"),

    // Sessions
    createSession: prepare("INSERT OR REPLACE INTO wa_sessions (session_name, status) VALUES (?, ?)"),
    updateSessionStatus: prepare("UPDATE wa_sessions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE session_name = ?"),
    updateSessionPhone: prepare("UPDATE wa_sessions SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE session_name = ?"),
    deleteSession: prepare("DELETE FROM wa_sessions WHERE session_name = ?"),
    getAllSessions: prepare("SELECT * FROM wa_sessions ORDER BY created_at DESC"),

    // OTP Logs
    insertOtpLog: prepare("INSERT INTO otp_logs (session_name, sender, message, otp_code, app_name) VALUES (?, ?, ?, ?, ?)"),
    getOtpLogs: prepare("SELECT * FROM otp_logs ORDER BY created_at DESC LIMIT ?"),
    getOtpLogsBySession: prepare("SELECT * FROM otp_logs WHERE session_name = ? ORDER BY created_at DESC LIMIT ?"),
    getOtpStats: prepare("SELECT session_name, COUNT(*) as count, MAX(created_at) as last_otp FROM otp_logs GROUP BY session_name"),
    clearOtpLogs: prepare("DELETE FROM otp_logs"),
  };
}

module.exports = {
  initDB,
  get ready() { return ready; },
  get getUser() { return queries.getUser; },
  get createSession() { return queries.createSession; },
  get updateSessionStatus() { return queries.updateSessionStatus; },
  get updateSessionPhone() { return queries.updateSessionPhone; },
  get deleteSession() { return queries.deleteSession; },
  get getAllSessions() { return queries.getAllSessions; },
  get insertOtpLog() { return queries.insertOtpLog; },
  get getOtpLogs() { return queries.getOtpLogs; },
  get getOtpLogsBySession() { return queries.getOtpLogsBySession; },
  get getOtpStats() { return queries.getOtpStats; },
  get clearOtpLogs() { return queries.clearOtpLogs; },
  setupQueries,
  saveDB,
};
