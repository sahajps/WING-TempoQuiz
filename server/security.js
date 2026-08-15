'use strict';

const crypto = require('node:crypto');

const config = require('./config');
const { HttpError } = require('./util');

/** Minimal cookie header parser; avoids pulling in cookie-parser. */
function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function cookieMiddleware(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  next();
}

function setCookie(res, name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  const existing = res.getHeader('Set-Cookie');
  const header = parts.join('; ');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, header) : header);
}

function clearCookie(res, name, options = {}) {
  setCookie(res, name, '', { ...options, maxAge: 0 });
}

/**
 * True when the browser reached us over TLS. Behind ngrok the local hop is
 * plain HTTP, so this relies on the X-Forwarded-Proto header that Express
 * exposes through `trust proxy`.
 */
function isSecureRequest(req) {
  return req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
}

function securityHeaders(_req, res, next) {
  // Everything is served from this origin, so the policy can be strict. The
  // exceptions are question images, which instructors legitimately hotlink
  // from elsewhere, and QR codes, which are inlined as data: URIs.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      // Inline style attributes are used for layout throughout the pages.
      // This is deliberately narrower than it looks: script-src stays strict,
      // and no user-supplied text is ever interpolated into markup — the
      // front end builds every node through textContent.
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // ngrok's free tier shows an interstitial to browsers unless this is set;
  // echoing it keeps XHR polling from receiving that HTML page instead of JSON.
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.removeHeader('X-Powered-By');
  next();
}

/**
 * Fixed-window in-memory rate limiter. State is per-process, which is the
 * right scope here because the app runs as a single Node process.
 */
function createRateLimiter({ windowMs, max, name }) {
  const hits = new Map();

  function sweep(now) {
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    if (hits.size > 5000) sweep(now);

    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      next(new HttpError(429, `Too many ${name} requests. Try again in ${retryAfter}s.`));
      return;
    }
    next();
  };
}

/**
 * Double-submit CSRF check. The session holds a hash of the token; the client
 * echoes the token it was given at login in a header. A cross-site page can
 * make the browser send the cookie but cannot read the token to set the header.
 */
function requireCsrf(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const provided = req.get('x-csrf-token') || (req.body && req.body.csrfToken);
  if (!provided || !req.adminSession) {
    next(new HttpError(403, 'Missing CSRF token. Reload the admin page and sign in again.'));
    return;
  }
  const providedHash = crypto.createHash('sha256').update(String(provided)).digest();
  const expectedHash = crypto.createHash('sha256').update(String(req.adminSession.csrf_token)).digest();
  if (!crypto.timingSafeEqual(providedHash, expectedHash)) {
    next(new HttpError(403, 'Invalid CSRF token. Reload the admin page and sign in again.'));
    return;
  }
  next();
}

/**
 * Rejects cross-origin state changes outright. Combined with SameSite=Lax this
 * is belt and braces, but it costs nothing and covers older browsers.
 */
function sameOriginOnly(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    next();
    return;
  }
  const origin = req.get('origin');
  if (!origin) {
    next();
    return;
  }
  const host = req.get('x-forwarded-host') || req.get('host');
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    next(new HttpError(403, 'Bad Origin header'));
    return;
  }
  if (originHost !== host) {
    next(new HttpError(403, 'Cross-origin request refused'));
    return;
  }
  next();
}

/** Resolves the externally reachable base URL, used to build QR targets. */
function publicBaseUrl(req) {
  if (config.PUBLIC_URL) return config.PUBLIC_URL;
  const proto = isSecureRequest(req) ? 'https' : req.protocol || 'http';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

module.exports = {
  parseCookies,
  cookieMiddleware,
  setCookie,
  clearCookie,
  isSecureRequest,
  securityHeaders,
  createRateLimiter,
  requireCsrf,
  sameOriginOnly,
  publicBaseUrl,
};
