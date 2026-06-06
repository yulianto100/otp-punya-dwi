/**
 * WA OTP Manager - Main Server
 * Express + WebSocket server for WhatsApp OTP management
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');

const { login, authMiddleware } = require('./lib/auth');
const db = require('./lib/db');
const waClient = require('./lib/wa-client');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(authMiddleware);

// WebSocket connections
const wsClients = new Set();

wss.on('connection', (ws, req) => {
  // Verify token from query params
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  const { verify } = require('./lib/auth');
  const decoded = verify(token);
  if (!decoded) {
    ws.close(1008, 'Invalid token');
    return;
  }

  wsClients.add(ws);
  console.log(`[WS] Client connected. Total: ${wsClients.size}`);

  // Send current state
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      sessions: waClient.getActiveSessions(),
      maxSessions: waClient.MAX_SESSIONS,
    }
  }));

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${wsClients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
    wsClients.delete(ws);
  });
});

// Broadcast to all connected WebSocket clients
function broadcast(data) {
  const message = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  }
}

// Set broadcast function for WA client
waClient.setBroadcast(broadcast);

// ==================== API Routes ====================

// Auth
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }

  const result = login(username, password);
  if (result.error) {
    return res.status(401).json({ error: result.error });
  }

  res.cookie('token', result.token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
  res.json({ token: result.token, username: result.username });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Session Management
app.get('/api/sessions', (req, res) => {
  const sessions = waClient.getActiveSessions();
  res.json({
    sessions,
    maxSessions: waClient.MAX_SESSIONS,
    activeCount: waClient.getSessionCount(),
  });
});

app.post('/api/sessions', async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Nama session wajib diisi' });
  }

  // Sanitize session name
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 30);
  if (!safeName) {
    return res.status(400).json({ error: 'Nama session tidak valid' });
  }

  const result = await waClient.createSession(safeName);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.json(result);
});

app.delete('/api/sessions/:name', async (req, res) => {
  const result = await waClient.logoutSession(req.params.name);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

app.post('/api/sessions/:name/disconnect', async (req, res) => {
  const result = await waClient.disconnectSession(req.params.name);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }
  res.json(result);
});

// OTP Logs
app.get('/api/otp-logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const session = req.query.session;

  let logs;
  if (session) {
    logs = db.getOtpLogsBySession.all(session, limit);
  } else {
    logs = db.getOtpLogs.all(limit);
  }

  res.json({ logs });
});

app.delete('/api/otp-logs', (req, res) => {
  db.clearOtpLogs.run();
  broadcast({ type: 'otp_cleared' });
  res.json({ success: true });
});

// Stats
app.get('/api/stats', (req, res) => {
  const otpStats = db.getOtpStats.all();
  const sessions = waClient.getActiveSessions();

  res.json({
    activeSessions: sessions.length,
    maxSessions: waClient.MAX_SESSIONS,
    otpBySession: otpStats,
    sessions,
  });
});

// QR Code as image (for embedding)
app.get('/api/sessions/:name/qr', (req, res) => {
  const sessions = waClient.getActiveSessions();
  const session = sessions.find(s => s.name === req.params.name);

  if (!session || !session.qr) {
    return res.status(404).json({ error: 'QR tidak tersedia' });
  }

  // Return the data URL
  res.json({ qr: session.qr });
});

// ==================== HTML Routes ====================

// Serve login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve dashboard (default)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch all - serve index (Express 5 requires named parameter)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    next();
  }
});

// ==================== Start Server ====================

async function startServer() {
  // Initialize database first
  await db.initDB();
  db.setupQueries();

  server.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║     🟢 WA OTP Manager Started!      ║');
    console.log('  ╠══════════════════════════════════════╣');
    console.log(`  ║  Dashboard: http://localhost:${PORT}    ║`);
    console.log('  ║  Login:     admin / admin123         ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');

    // Restore previous sessions
    waClient.restoreSessions();
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down...');
  db.saveDB();
  server.close();
  process.exit(0);
});
