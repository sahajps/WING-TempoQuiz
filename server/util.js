'use strict';

const crypto = require('node:crypto');

// I and O and 0 and 1 are omitted so a room code read off a projector is not
// ambiguous when a student types it into their phone.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function nowIso() {
  return new Date().toISOString();
}

function todayStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function randomCode(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Constant-time comparison that tolerates different-length inputs without
 * leaking the length through an early return.
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function slugify(value, fallback = 'quiz') {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/**
 * Collapses a question prompt to a comparable form so the same question typed
 * with different spacing, casing or punctuation is still recognised as a
 * duplicate of one already in the bank.
 */
function fingerprintQuestion(prompt, options = []) {
  const normalise = (text) => String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const body = normalise(prompt);
  const choices = options
    .map((option) => normalise(typeof option === 'string' ? option : option.text))
    .filter(Boolean)
    .sort()
    .join('|');
  return sha256(`${body}::${choices}`);
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Escapes a value for safe inclusion in a CSV cell. */
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRows(rows) {
  // A BOM makes Excel open UTF-8 exports without mangling accented names.
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Wraps an async Express handler so rejections reach the error middleware. */
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function badRequest(message, details) {
  return new HttpError(400, message, details);
}

function notFound(message = 'Not found') {
  return new HttpError(404, message);
}

function forbidden(message = 'Not allowed') {
  return new HttpError(403, message);
}

function conflict(message, details) {
  return new HttpError(409, message, details);
}

module.exports = {
  CODE_ALPHABET,
  nowIso,
  todayStamp,
  randomCode,
  randomToken,
  sha256,
  safeEqual,
  slugify,
  fingerprintQuestion,
  clampInt,
  csvCell,
  csvRows,
  asyncRoute,
  HttpError,
  badRequest,
  notFound,
  forbidden,
  conflict,
};
