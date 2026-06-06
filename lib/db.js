const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', 'data', 'otp-manager.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS wa_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_name TEXT UNIQUE NOT NULL,
    phone_number TEXT,
    status TEXT DEFAULT 'disconnected',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME
  );

  CREATE TABLE IF NOT EXISTS otp_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_name TEXT NOT NULL,
    sender TEXT,
    message TEXT,
    otp_code TEXT,
    app_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_otp_session ON otp_logs(session_name);
  CREATE INDEX IF NOT EXISTS idx_otp_created ON otp_logs(created_at DESC);
`);

// Seed default admin user if none exists
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (userCount.count === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('admin', hash);
  console.log('[DB] Default user created: admin / admin123');
}

module.exports = {
  // Users
  getUser: db.prepare('SELECT * FROM users WHERE username = ?'),
  createUser: db.prepare('INSERT INTO users (username, password) VALUES (?, ?)'),

  // Sessions
  getAllSessions: db.prepare('SELECT * FROM wa_sessions ORDER BY created_at DESC'),
  getSession: db.prepare('SELECT * FROM wa_sessions WHERE session_name = ?'),
  createSession: db.prepare('INSERT OR REPLACE INTO wa_sessions (session_name, status) VALUES (?, ?)'),
  updateSessionStatus: db.prepare('UPDATE wa_sessions SET status = ?, last_active = CURRENT_TIMESTAMP WHERE session_name = ?'),
  updateSessionPhone: db.prepare('UPDATE wa_sessions SET phone_number = ? WHERE session_name = ?'),
  deleteSession: db.prepare('DELETE FROM wa_sessions WHERE session_name = ?'),

  // OTP Logs
  insertOtpLog: db.prepare('INSERT INTO otp_logs (session_name, sender, message, otp_code, app_name) VALUES (?, ?, ?, ?, ?)'),
  getOtpLogs: db.prepare('SELECT * FROM otp_logs ORDER BY created_at DESC LIMIT ?'),
  getOtpLogsBySession: db.prepare('SELECT * FROM otp_logs WHERE session_name = ? ORDER BY created_at DESC LIMIT ?'),
  clearOtpLogs: db.prepare('DELETE FROM otp_logs'),
  getOtpStats: db.prepare('SELECT session_name, COUNT(*) as count FROM otp_logs GROUP BY session_name'),

  db
};
