import express from 'express';
import basicAuth from 'basic-auth';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { config, validateRequiredConfig } from './config.js';
import { logger } from './services/logger.js';
import { initDb } from './db/migrate.js';
import { adminRouter } from './admin/routes.js';
import { messengerRouter } from './channels/messenger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// View engine for Admin UI
app.set('view engine', 'ejs');
app.set('views', resolve(__dirname, 'admin/views'));

// Raw body for Messenger signature verification MUST be mounted BEFORE
// express.json(): a global JSON parser would consume the stream first, leaving
// only re-encoded bytes for HMAC and breaking signature verification.
app.use('/webhook/messenger', express.raw({ type: 'application/json', limit: '1mb' }));

// Middleware
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '200kb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('HTTP', {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: duration,
    });
  });
  next();
});

// Constant-time string comparison via SHA-256 hashes (always 32 bytes, so
// length-normalized) to avoid leaking credential prefix info via timing.
function credentialsMatch(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(expected ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------- admin session ---
//
// Stateless session, no express-session and no server-side store: the cookie
// carries "<username>.<issuedAt>.<expiresAt>" signed with HMAC-SHA256. That keeps
// the dependency list untouched and makes a single-operator login survive a
// server restart. Legacy HTTP Basic Auth is still accepted (curl, ngrok tunnel,
// API clients) so nothing that authenticates today breaks.

const SESSION_COOKIE = 'admin_session';
const SESSION_TTL_SHORT_MS = 8 * 60 * 60 * 1000; // 8h   — "Ghi nhớ đăng nhập" unticked
const SESSION_TTL_LONG_MS = 30 * 24 * 60 * 60 * 1000; // 30d — "Ghi nhớ đăng nhập" ticked
// Generated fallback secret lives next to the DB (project/data/) so a restart
// does not invalidate every cookie. The value itself is never logged.
const SESSION_SECRET_FILE = resolve(__dirname, '../data/session-secret.key');

// Failed-login throttle (in-memory, per client IP). Cheap and dependency-free;
// it is a genuine improvement over the previous zero-attempt-limit Basic Auth.
const LOGIN_FAIL_LIMIT = 10;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const loginFails = new Map(); // key -> { count, firstAt }

function capStr(v, max) {
  const s = String(v ?? '');
  return s.length > max ? s.slice(0, max) : s;
}

// Checkbox values vary by browser ('on', '1', 'true'); repeated field names
// arrive as arrays because the urlencoded parser runs with extended: true.
function isTruthyField(v) {
  const raw = Array.isArray(v) ? v[0] : v;
  if (raw === undefined || raw === null) return false;
  const s = String(raw).trim().toLowerCase();
  return s === 'on' || s === '1' || s === 'true' || s === 'yes';
}

// Same-origin guard for the two auth POSTs. adminRouter has its own copy
// (src/admin/routes.js) but that router is mounted *after* adminAuth, so these
// two endpoints need the check here. Same-origin form posts and header-less
// clients (curl) pass; a cross-site form post is refused.
function checkSameOriginPost(req, res, next) {
  const origin = req.get('Origin') || req.get('Referer');
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return res.status(403).send('Forbidden: invalid Origin');
    }
    const host = (req.get('Host') || '').toLowerCase();
    if (!host || originHost !== host) {
      return res.status(403).send('Forbidden: cross-origin POST rejected');
    }
  }
  next();
}

// Secret precedence: SESSION_SECRET from .env, else a generated value persisted
// next to the DB. Only the key name and the file path are ever logged.
function loadSessionSecret() {
  const fromEnv = String(process.env.SESSION_SECRET || '').trim();
  if (fromEnv) return fromEnv;
  try {
    if (existsSync(SESSION_SECRET_FILE)) {
      const saved = readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
      if (saved) return saved;
    }
    const generated = crypto.randomBytes(32).toString('base64url');
    mkdirSync(dirname(SESSION_SECRET_FILE), { recursive: true });
    writeFileSync(SESSION_SECRET_FILE, `${generated}\n`, { mode: 0o600 });
    logger.info(
      'SESSION_SECRET not set — generated one and kept it in data/session-secret.key'
    );
    return generated;
  } catch (err) {
    // Read-only data dir (or no permission): fall back to an ephemeral secret.
    // Sessions then end on restart, which beats signing with a constant.
    logger.warn(
      'Could not persist a session secret; using an in-memory one (sessions end on restart)',
      { error: err.message }
    );
    return crypto.randomBytes(32).toString('base64url');
  }
}

const sessionSecret = loadSessionSecret();

function signSessionPayload(payload) {
  return crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
}

// "<base64url payload>.<base64url signature>". The payload is base64url-encoded
// so a username containing '.' can never break the field split.
function createSessionToken(username, ttlMs) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + ttlMs;
  const payload = `${username}.${issuedAt}.${expiresAt}`;
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${signSessionPayload(payload)}`;
}

// Returns { username, issuedAt, expiresAt } or null. Every rejection path is
// indistinguishable from the outside: no reason codes, constant-time signature
// comparison, and no cookie-specific error surface.
function readSessionToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot >= token.length - 1) return null;

  let payload;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const given = Buffer.from(token.slice(dot + 1), 'utf8');
  const wanted = Buffer.from(signSessionPayload(payload), 'utf8');
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return null;

  const parts = payload.split('.');
  if (parts.length !== 3) return null;
  const [user, issuedAtRaw, expiresAtRaw] = parts;
  const issuedAt = Number(issuedAtRaw);
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= Date.now()) return null;
  if (issuedAt > Date.now() + 60 * 1000) return null; // clock-skew guard
  // Changing ADMIN_USERNAME in .env must invalidate every cookie out there.
  if (!credentialsMatch(user, config.adminUsername)) return null;

  return { username: user, issuedAt, expiresAt };
}

// No cookie-parser dependency: read the one cookie we care about by hand.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

function isSessionRequest(req) {
  return readSessionToken(readCookie(req, SESSION_COOKIE)) !== null;
}

function isHttps(req) {
  if (req.secure) return true;
  return String(req.get('X-Forwarded-Proto') || '').split(',')[0].trim().toLowerCase() === 'https';
}

const sessionCookieOptions = (req) => ({
  httpOnly: true,
  sameSite: 'lax',
  path: '/admin',
  // Only demand https when the request really arrived over https, otherwise the
  // cookie would never be stored on http://localhost:3000.
  secure: isHttps(req),
});

// "next" arrives straight from a query string or a hidden field, so only
// same-origin absolute paths are honoured: one leading slash, no "//" or "/\"
// (protocol-relative), no control characters, and never the auth endpoints
// themselves (which would bounce the operator in a loop).
function safeNext(raw) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === null) return '';
  const p = String(value).trim();
  if (p === '' || p.length > 512) return '';
  if (p[0] !== '/') return '';
  if (p[1] === '/' || p[1] === '\\') return '';
  if (/[\u0000-\u001f\u007f]/.test(p)) return ''; // header/line injection
  if (p.startsWith('/admin/login') || p.startsWith('/admin/logout')) return '';
  return p;
}

function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown').toLowerCase();
}

// Drop expired buckets once the map grows; keeps memory flat without a timer.
function pruneLoginFails(now) {
  if (loginFails.size < 512) return;
  for (const [key, entry] of loginFails) {
    if (now - entry.firstAt >= LOGIN_FAIL_WINDOW_MS) loginFails.delete(key);
  }
}

// Minutes left on the throttle, or 0 when the client may try again. The window
// is fixed-width: the bucket only clears once it ages out, so a client that
// keeps hammering it stays locked out for the full 15 minutes.
function loginBlockedFor(key) {
  const entry = loginFails.get(key);
  if (!entry) return 0;
  const waited = Date.now() - entry.firstAt;
  if (waited >= LOGIN_FAIL_WINDOW_MS) {
    loginFails.delete(key);
    return 0;
  }
  if (entry.count < LOGIN_FAIL_LIMIT) return 0;
  return Math.ceil((LOGIN_FAIL_WINDOW_MS - waited) / 60000);
}

function noteLoginFailure(key) {
  const now = Date.now();
  pruneLoginFails(now);
  const entry = loginFails.get(key);
  if (!entry || now - entry.firstAt >= LOGIN_FAIL_WINDOW_MS) {
    loginFails.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(key) {
  loginFails.delete(key);
}

// Only real page navigations (GET/HEAD asking for text/html) are sent to the
// login page — never XHR, never JSON, never a form POST — so the native Basic
// Auth dialog cannot appear in the normal browser flow while fetch() callers in
// views/agent.ejs keep getting today's 401 + WWW-Authenticate.
function prefersLoginPage(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.get('X-Requested-With')) return false;
  if (req.is('application/json')) return false;
  return (req.get('Accept') || '').toLowerCase().includes('text/html');
}

// Auth gate for every /admin route: signed session cookie OR legacy Basic Auth.
function adminAuth(req, res, next) {
  if (isSessionRequest(req)) return next();

  const user = basicAuth(req);
  const nameOk = credentialsMatch(user?.name, config.adminUsername);
  const passOk = credentialsMatch(user?.pass, config.adminPassword);
  if (nameOk && passOk) return next();

  if (prefersLoginPage(req)) {
    const target = capStr(req.originalUrl, 512);
    return res.redirect(302, `/admin/login?next=${encodeURIComponent(target)}`);
  }

  res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
  return res.status(401).send('Authentication required');
}

// The login page must never be cached: it carries the error text and the
// submitted username, and an intermediary cache must not keep either around.
function renderLogin(res, statusCode, locals) {
  return res
    .status(statusCode)
    .set('Cache-Control', 'no-store')
    .render('login', { error: '', username: '', next: '', ...locals });
}

// Health check (includes Telegram channel status; never crashes on channel errors)
app.get('/health', async (req, res) => {
  let telegram = { enabled: config.telegramEnabled, connected: false };
  try {
    const m = await import('./channels/telegram.js');
    if (typeof m.getTelegramStatus === 'function') {
      telegram = { enabled: config.telegramEnabled, ...m.getTelegramStatus() };
    }
  } catch {
    // telegram.js missing/unloadable: report disabled-shape, stay 200.
  }
  res.json({ status: 'ok', timestamp: new Date().toISOString(), telegram });
});

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'Chatbot Ban Hang',
    channels: ['telegram', 'messenger'],
    version: '1.0.0',
    status: 'running'
  });
});

// Auth pages — declared BEFORE the adminAuth mount below so they stay reachable
// while signed out. Changing state is POST-only, never a link.
app.get('/admin/login', (req, res) => {
  const next = safeNext(req.query.next);
  if (isSessionRequest(req)) return res.redirect(302, next || '/admin');
  return renderLogin(res, 200, { next });
});

app.post('/admin/login', checkSameOriginPost, (req, res) => {
  const key = clientKey(req);
  // Body parsers skip non-matching content types; never trust req.body to exist.
  const body = req.body || {};

  const waitMinutes = loginBlockedFor(key);
  if (waitMinutes > 0) {
    logger.warn('Admin login throttled', { ip: key, waitMinutes });
    res.set('Retry-After', String(waitMinutes * 60));
    return renderLogin(res, 429, {
      error: `Bạn đã thử đăng nhập quá nhiều lần. Vui lòng thử lại sau ${waitMinutes} phút nữa.`,
      username: capStr(body.username, 100).trim(),
      next: safeNext(body.next),
    });
  }

  const username = capStr(body.username, 100).trim();
  const password = capStr(body.password, 200);
  const next = safeNext(body.next) || '/admin';

  // Both hashes are always computed (no short-circuit) so a wrong username and
  // a wrong password take the same amount of time.
  const nameOk = credentialsMatch(username, config.adminUsername);
  const passOk = credentialsMatch(password, config.adminPassword);

  if (!nameOk || !passOk) {
    noteLoginFailure(key);
    logger.warn('Failed admin login', { ip: key, username });
    return renderLogin(res, 401, {
      error: 'Tài khoản hoặc mật khẩu không đúng.',
      username, // password is deliberately never sent back
      next,
    });
  }

  clearLoginFailures(key);
  const remember = isTruthyField(body.remember);
  const ttlMs = remember ? SESSION_TTL_LONG_MS : SESSION_TTL_SHORT_MS;
  const token = createSessionToken(config.adminUsername, ttlMs);
  res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(req), maxAge: ttlMs });
  logger.info('Admin signed in', { ip: key, username, remember });
  return res.redirect(302, next);
});

app.post('/admin/logout', checkSameOriginPost, (req, res) => {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions(req));
  logger.info('Admin signed out', { ip: clientKey(req) });
  return res.redirect(302, '/admin/login');
});

// Admin routes (protected) — static import so routes are declared before the
// 404 handler below; a broken router fails fast at boot instead of 404ing.
app.use('/admin', adminAuth);
app.use('/admin', adminRouter);

// Messenger webhook routes (raw-body middleware above already ran for this path)
// Disabled entirely when MESSENGER_ENABLED=false (Telegram-only mode).
if (config.messengerEnabled) {
  app.use('/webhook/messenger', messengerRouter);
} else {
  logger.info('Messenger channel disabled (MESSENGER_ENABLED=false), webhook not mounted');
}

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
let server;
async function start() {
  try {
    // Initialize database
    await initDb();
    logger.info('Database initialized');

    // Housekeeping: drop week-old dedup entries so processed_events stays small.
    try {
      const { pruneProcessedEvents } = await import('./core/dedup.js');
      logger.info(`Pruned ${pruneProcessedEvents(7)} old processed events`);
    } catch {
      // Non-critical; continue boot.
    }

    // Validate config
    validateRequiredConfig();

    // Loud warning only: never lock out dev by refusing to start here.
    if (config.nodeEnv === 'production' && config.adminPassword === 'doi-mat-khau-nay') {
      logger.warn(
        'SECURITY WARNING: ADMIN_PASSWORD is still the documented default (.env.example) ' +
        'while NODE_ENV=production. Change ADMIN_PASSWORD immediately — the admin UI is exposed.'
      );
    }

    // Start server
    server = app.listen(config.port, () => {
      logger.info(`Server started on port ${config.port}`);
      logger.info(`Environment: ${config.nodeEnv}`);
      logger.info(`Admin UI: http://localhost:${config.port}/admin`);
      logger.info(`Health: http://localhost:${config.port}/health`);
    });

    // Telegram long-polling (no public URL needed). Dynamic import so the
    // telegraf dependency only loads when the channel is enabled.
    if (config.telegramEnabled) {
      try {
        const { startTelegram } = await import('./channels/telegram.js');
        await startTelegram();
      } catch (err) {
        logger.error('Telegram failed to start (server keeps running without it)', {
          error: err.message,
        });
      }
    }

  } catch (error) {
    logger.error('Failed to start server', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

async function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  if (config.telegramEnabled) {
    try {
      const m = await import('./channels/telegram.js');
      if (m.stopTelegram) await m.stopTelegram();
    } catch {
      // Best effort; process exit below still happens.
    }
  }
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();