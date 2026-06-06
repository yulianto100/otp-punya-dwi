/**
 * WhatsApp Client Manager - Multi-session Baileys manager
 * Supports both QR code and pairing code connection
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { processMessage } = require('./otp-detector');
const db = require('./db');

const MAX_SESSIONS = 5;
const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'sessions');

// Ensure directories exist
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Active sessions store
const activeSessions = new Map();

// WebSocket broadcast function (set by server)
let broadcastWS = () => {};

function setBroadcast(fn) {
  broadcastWS = fn;
}

function getActiveSessions() {
  const sessions = [];
  for (const [name, session] of activeSessions) {
    sessions.push({
      name,
      phone: session.phone || null,
      status: session.status,
      pairingCode: session.pairingCode || null,
      connectedAt: session.connectedAt || null,
    });
  }
  return sessions;
}

function getSessionCount() {
  return activeSessions.size;
}

/**
 * Create a new session with pairing code support
 */
async function createSession(sessionName) {
  if (activeSessions.has(sessionName)) {
    return { error: `Session "${sessionName}" sudah aktif` };
  }

  if (activeSessions.size >= MAX_SESSIONS) {
    return { error: `Maksimal ${MAX_SESSIONS} session aktif. Logout salah satu dulu.` };
  }

  const sessionPath = path.join(SESSIONS_DIR, sessionName);
  fs.mkdirSync(sessionPath, { recursive: true });

  const session = {
    name: sessionName,
    phone: null,
    status: 'connecting',
    pairingCode: null,
    sock: null,
    connectedAt: null,
  };

  activeSessions.set(sessionName, session);
  db.createSession.run(sessionName, 'connecting');

  broadcastWS({
    type: 'session_update',
    data: { name: sessionName, status: 'connecting', phone: null }
  });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: ['WA OTP Manager', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: undefined,
      keepAliveIntervalMs: 30_000,
      // Generate pairing code
      generateHighQualityLinkPreview: false,
    });

    session.sock = sock;

    // Handle credentials update
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, pairingCode } = update;

      if (pairingCode) {
        // Pairing code received
        session.pairingCode = pairingCode;
        session.status = 'pairing_code';
        db.updateSessionStatus.run('pairing_code', sessionName);

        console.log(`[WA] ${sessionName} pairing code: ${pairingCode}`);

        broadcastWS({
          type: 'pairing_code',
          data: { name: sessionName, code: pairingCode }
        });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[WA] ${sessionName} connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);

        if (shouldReconnect) {
          session.status = 'reconnecting';
          db.updateSessionStatus.run('reconnecting', sessionName);
          broadcastWS({
            type: 'session_update',
            data: { name: sessionName, status: 'reconnecting' }
          });

          // Reconnect after delay
          setTimeout(() => {
            if (activeSessions.has(sessionName)) {
              connectSession(sessionName);
            }
          }, 5000);
        } else {
          // Logged out - clean up
          session.status = 'disconnected';
          db.updateSessionStatus.run('disconnected', sessionName);
          broadcastWS({
            type: 'session_update',
            data: { name: sessionName, status: 'disconnected' }
          });
          activeSessions.delete(sessionName);
        }
      }

      if (connection === 'open') {
        session.status = 'connected';
        session.pairingCode = null;
        session.connectedAt = new Date().toISOString();
        session.phone = sock.user?.id?.split(':')[0] || null;
        db.updateSessionStatus.run('connected', sessionName);
        if (session.phone) {
          db.updateSessionPhone.run(session.phone, sessionName);
        }

        console.log(`[WA] ${sessionName} connected! Phone: ${session.phone}`);

        broadcastWS({
          type: 'session_update',
          data: {
            name: sessionName,
            status: 'connected',
            phone: session.phone,
            connectedAt: session.connectedAt,
          }
        });
      }
    });

    // Handle incoming messages - OTP detection
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        // Skip status broadcasts and own messages
        if (msg.key.fromMe) continue;
        if (msg.key.remoteJid === 'status@broadcast') continue;

        const messageText = msg.message?.conversation
          || msg.message?.extendedTextMessage?.text
          || msg.message?.imageMessage?.caption
          || msg.message?.videoMessage?.caption
          || '';

        if (!messageText) continue;

        const sender = msg.key.remoteJid?.replace('@s.whatsapp.net', '') || 'unknown';
        const pushName = msg.pushName || sender;

        // Detect OTP
        const otpResult = processMessage(messageText);

        if (otpResult) {
          console.log(`[OTP] ${sessionName} | ${pushName} | ${otpResult.otp} | ${otpResult.app}`);

          // Save to database
          db.insertOtpLog.run(sessionName, pushName, messageText, otpResult.otp, otpResult.app);

          // Broadcast to dashboard
          broadcastWS({
            type: 'otp',
            data: {
              session: sessionName,
              sender: pushName,
              senderNumber: sender,
              otp: otpResult.otp,
              app: otpResult.app,
              confidence: otpResult.confidence,
              message: messageText.substring(0, 200),
              timestamp: new Date().toISOString(),
            }
          });
        }

        // Also broadcast all messages for monitoring
        broadcastWS({
          type: 'message',
          data: {
            session: sessionName,
            sender: pushName,
            senderNumber: sender,
            text: messageText.substring(0, 200),
            hasOtp: !!otpResult,
            otp: otpResult?.otp || null,
            timestamp: new Date().toISOString(),
          }
        });
      }
    });

    console.log(`[WA] ${sessionName} session initialized`);
    return { success: true, name: sessionName };

  } catch (err) {
    console.error(`[WA] Error creating session ${sessionName}:`, err.message);
    session.status = 'error';
    activeSessions.delete(sessionName);
    db.updateSessionStatus.run('error', sessionName);
    return { error: err.message };
  }
}

/**
 * Connect an existing session
 */
async function connectSession(sessionName) {
  const session = activeSessions.get(sessionName);
  if (!session) {
    return createSession(sessionName);
  }

  if (session.sock) {
    try {
      session.sock.end();
    } catch {}
  }

  return createSession(sessionName);
}

/**
 * Logout and clean up session
 */
async function logoutSession(sessionName) {
  const session = activeSessions.get(sessionName);
  if (!session) {
    return { error: `Session "${sessionName}" tidak ditemukan` };
  }

  try {
    if (session.sock) {
      await session.sock.logout();
      session.sock.end();
    }
  } catch (err) {
    console.log(`[WA] Logout error for ${sessionName}:`, err.message);
  }

  // Clean up session data
  const sessionPath = path.join(SESSIONS_DIR, sessionName);
  try {
    fs.rmSync(sessionPath, { recursive: true, force: true });
  } catch {}

  activeSessions.delete(sessionName);
  db.deleteSession.run(sessionName);

  broadcastWS({
    type: 'session_removed',
    data: { name: sessionName }
  });

  console.log(`[WA] ${sessionName} logged out and cleaned up`);
  return { success: true };
}

/**
 * Disconnect session (keep data for reconnect)
 */
async function disconnectSession(sessionName) {
  const session = activeSessions.get(sessionName);
  if (!session) {
    return { error: `Session "${sessionName}" tidak ditemukan` };
  }

  try {
    if (session.sock) {
      session.sock.end();
    }
  } catch {}

  session.status = 'disconnected';
  activeSessions.delete(sessionName);
  db.updateSessionStatus.run('disconnected', sessionName);

  broadcastWS({
    type: 'session_update',
    data: { name: sessionName, status: 'disconnected' }
  });

  return { success: true };
}

/**
 * Restore sessions from database on startup
 */
async function restoreSessions() {
  try {
    const sessions = db.getAllSessions.all();
    let restored = 0;

    for (const sess of sessions) {
      if (sess.status === 'connected' || sess.status === 'connecting') {
        const sessionPath = path.join(SESSIONS_DIR, sess.session_name);
        if (fs.existsSync(sessionPath)) {
          console.log(`[WA] Restoring session: ${sess.session_name}`);
          await createSession(sess.session_name);
          restored++;
        }
      }
    }

    if (restored > 0) {
      console.log(`[WA] Restored ${restored} session(s)`);
    }
  } catch (err) {
    console.error('[WA] Error restoring sessions:', err.message);
  }
}

module.exports = {
  createSession,
  logoutSession,
  disconnectSession,
  getActiveSessions,
  getSessionCount,
  restoreSessions,
  setBroadcast,
  MAX_SESSIONS,
};
