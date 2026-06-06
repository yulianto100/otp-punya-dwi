const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'wa-otp-manager-secret-key-change-me';
const JWT_EXPIRES = '7d';

function login(username, password) {
  const user = db.getUser.get(username);
  if (!user) return { error: 'Username tidak ditemukan' };
  if (!bcrypt.compareSync(password, user.password)) return { error: 'Password salah' };

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  return { token, username: user.username };
}

function verify(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function authMiddleware(req, res, next) {
  // Skip auth for login page and static assets
  if (req.path === '/api/auth/login' || !req.path.startsWith('/api/')) {
    return next();
  }

  const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const decoded = verify(token);
  if (!decoded) return res.status(401).json({ error: 'Token expired' });

  req.user = decoded;
  next();
}

module.exports = { login, verify, authMiddleware, JWT_SECRET };
