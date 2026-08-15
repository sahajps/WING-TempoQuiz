'use strict';

const crypto = require('node:crypto');

const config = require('./config');
const { query, transaction } = require('./db');
const { nowIso, randomToken, HttpError } = require('./util');
const { setCookie, clearCookie, isSecureRequest } = require('./security');

const COOKIE_NAME = 'tq_admin';

// scrypt parameters. N=16384 keeps a single verification around 50-80ms on a
// laptop: slow enough to make offline guessing expensive, fast enough that a
// login does not feel sluggish.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return { hash: derived.toString('hex'), salt };
}

function verifyPassword(password, hash, salt) {
  const expected = Buffer.from(hash, 'hex');
  let derived;
  try {
    derived = crypto.scryptSync(String(password), salt, expected.length, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Session tokens are stored as an HMAC rather than a bare hash, so that
 * read access to the database file alone is not enough to mint a valid cookie.
 */
function tokenFingerprint(token) {
  return crypto.createHmac('sha256', config.SESSION_SECRET).update(String(token)).digest('hex');
}

function getAdmin() {
  return query.get('SELECT * FROM admin_account WHERE id = 1');
}

function passwordProblem(password) {
  const value = String(password ?? '');
  if (value.length < 10) return 'Password must be at least 10 characters.';
  if (value.length > 200) return 'Password must be 200 characters or fewer.';
  if (!/[a-zA-Z]/.test(value)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(value)) return 'Password must contain at least one number.';
  return null;
}

/**
 * Creates the single admin row if it does not exist. When no password is
 * configured a random one is generated and returned so the operator can be
 * shown it exactly once at first start.
 */
function ensureAdminAccount() {
  const existing = getAdmin();
  if (existing) return { created: false, username: existing.username, password: null };

  const username = config.BOOTSTRAP_USERNAME.trim() || 'admin';
  const configured = config.BOOTSTRAP_PASSWORD;
  const generated = configured || `wing-${randomToken(9)}`;
  const { hash, salt } = hashPassword(generated);
  const at = nowIso();

  query.run(
    `INSERT INTO admin_account (id, username, password_hash, password_salt, must_change, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
    username,
    hash,
    salt,
    configured ? 0 : 1,
    at,
    at,
  );
  return { created: true, username, password: generated, generated: !configured };
}

function setCredentials({ username, password }) {
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem);
  const cleanName = String(username ?? '').trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(cleanName)) {
    throw new HttpError(400, 'Username must be 3-40 characters: letters, numbers, dot, dash or underscore.');
  }
  const { hash, salt } = hashPassword(password);
  query.run(
    `UPDATE admin_account
        SET username = ?, password_hash = ?, password_salt = ?, must_change = 0, updated_at = ?
      WHERE id = 1`,
    cleanName,
    hash,
    salt,
    nowIso(),
  );
}

// --- login throttling -------------------------------------------------------

function recentFailures(ip) {
  const since = new Date(Date.now() - config.LOGIN_WINDOW_MIN * 60_000).toISOString();
  const row = query.get(
    'SELECT COUNT(*) AS n FROM login_attempt WHERE ip = ? AND ok = 0 AND at > ?',
    ip,
    since,
  );
  return row ? Number(row.n) : 0;
}

function recordAttempt(ip, username, ok) {
  query.run(
    'INSERT INTO login_attempt (ip, username, ok, at) VALUES (?, ?, ?, ?)',
    ip,
    username ? String(username).slice(0, 60) : null,
    ok ? 1 : 0,
    nowIso(),
  );
  // Keep the table small; anything past the window has no bearing on throttling.
  const cutoff = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  query.run('DELETE FROM login_attempt WHERE at < ?', cutoff);
}

function clearFailures(ip) {
  query.run('DELETE FROM login_attempt WHERE ip = ? AND ok = 0', ip);
}

// --- sessions ---------------------------------------------------------------

function createSession(req, res) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const id = randomToken(12);
  const created = new Date();
  const expires = new Date(created.getTime() + config.SESSION_HOURS * 3600_000);

  query.run(
    `INSERT INTO admin_session (id, token_hash, csrf_token, created_at, expires_at, last_seen, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    tokenFingerprint(token),
    // Held in the clear on purpose: a CSRF token is not a credential on its own
    // and is useless without the session cookie, but it must be re-readable so
    // a newly opened tab can be handed the same one instead of being locked out.
    csrfToken,
    created.toISOString(),
    expires.toISOString(),
    created.toISOString(),
    req.ip || null,
    String(req.get('user-agent') || '').slice(0, 200),
  );

  setCookie(res, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecureRequest(req),
    maxAge: config.SESSION_HOURS * 3600,
  });

  return { id, csrfToken, expiresAt: expires.toISOString() };
}

function readSession(req) {
  const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  if (!token) return null;
  const session = query.get(
    'SELECT * FROM admin_session WHERE token_hash = ?',
    tokenFingerprint(token),
  );
  if (!session) return null;
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    query.run('DELETE FROM admin_session WHERE id = ?', session.id);
    return null;
  }
  return session;
}

function touchSession(session) {
  query.run('UPDATE admin_session SET last_seen = ? WHERE id = ?', nowIso(), session.id);
}

function destroySession(req, res) {
  const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  if (token) query.run('DELETE FROM admin_session WHERE token_hash = ?', tokenFingerprint(token));
  clearCookie(res, COOKIE_NAME, { secure: isSecureRequest(req) });
}

function destroyAllSessions() {
  query.run('DELETE FROM admin_session');
}

function purgeExpiredSessions() {
  const result = query.run('DELETE FROM admin_session WHERE expires_at <= ?', nowIso());
  return result.changes;
}

/** Populates req.adminSession when a valid cookie is present. */
function attachSession(req, _res, next) {
  const session = readSession(req);
  if (session) {
    req.adminSession = session;
    touchSession(session);
  }
  next();
}

/** Blocks the request unless a valid admin session is attached. */
function requireAdmin(req, _res, next) {
  if (!req.adminSession) {
    next(new HttpError(401, 'Sign in as the administrator to do that.'));
    return;
  }
  next();
}

/**
 * Verifies a username/password pair, applying per-IP throttling. Returns the
 * admin row on success and throws an HttpError otherwise.
 */
function authenticate({ username, password, ip }) {
  if (recentFailures(ip) >= config.LOGIN_MAX_ATTEMPTS) {
    throw new HttpError(
      429,
      `Too many failed sign-ins from this address. Wait ${config.LOGIN_WINDOW_MIN} minutes and try again.`,
    );
  }

  const admin = getAdmin();
  const supplied = String(password ?? '');

  // Always run a scrypt derivation, even when the username is wrong, so that
  // response time does not reveal whether the username exists.
  const nameMatches = admin
    ? crypto.timingSafeEqual(
        crypto.createHash('sha256').update(String(username ?? '').trim().toLowerCase()).digest(),
        crypto.createHash('sha256').update(admin.username.toLowerCase()).digest(),
      )
    : false;
  const passwordMatches = admin
    ? verifyPassword(supplied, admin.password_hash, admin.password_salt)
    : verifyPassword(supplied, hashPassword('decoy').hash, 'decoy');

  if (!admin || !nameMatches || !passwordMatches) {
    recordAttempt(ip, username, false);
    throw new HttpError(401, 'Incorrect username or password.');
  }

  transaction(() => {
    recordAttempt(ip, username, true);
    clearFailures(ip);
  });
  return admin;
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  passwordProblem,
  getAdmin,
  ensureAdminAccount,
  setCredentials,
  authenticate,
  createSession,
  readSession,
  destroySession,
  destroyAllSessions,
  purgeExpiredSessions,
  attachSession,
  requireAdmin,
  recentFailures,
};
