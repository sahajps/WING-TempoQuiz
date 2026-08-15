'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'tempoquiz.yml');
const EXAMPLE_FILE = path.join(CONFIG_DIR, 'tempoquiz.example.yml');

// Any value still carrying this marker means the operator has not edited it.
const PLACEHOLDER = 'REPLACE_ME';

function isPlaceholder(value) {
  return typeof value === 'string' && value.trim().startsWith(PLACEHOLDER);
}

/**
 * Reads config/tempoquiz.yml. A missing file is not an error here: the server
 * may be running under test, or the operator may be about to be walked through
 * creating one. Malformed YAML is an error, and says which line.
 */
function readConfigFile(file = CONFIG_FILE) {
  if (!fs.existsSync(file)) return {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
  try {
    return YAML.parse(text) || {};
  } catch (error) {
    throw new Error(
      `${file} is not valid YAML.\n  ${error.message}\n` +
      '  Common causes: a tab used for indentation (YAML requires spaces), ' +
      'or a value containing ": " that is not wrapped in quotes.',
    );
  }
}

const file = readConfigFile();

/** Safely walks a dotted path through the parsed YAML. */
function at(dotted) {
  return dotted.split('.').reduce(
    (node, key) => (node && typeof node === 'object' ? node[key] : undefined),
    file,
  );
}

/**
 * Environment variables win over the YAML file. The file is the interface for
 * humans; env vars are what the test suite and any container runtime use.
 */
function str(envName, yamlPath, fallback = '') {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const fromYaml = at(yamlPath);
  if (fromYaml === undefined || fromYaml === null) return fallback;
  const value = String(fromYaml);
  return isPlaceholder(value) ? fallback : value;
}

function int(envName, yamlPath, fallback, min, max) {
  const raw = process.env[envName] !== undefined && process.env[envName] !== ''
    ? process.env[envName]
    : at(yamlPath);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(envName, yamlPath, fallback) {
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && fromEnv !== '') return !['false', '0', 'no'].includes(fromEnv.toLowerCase());
  const fromYaml = at(yamlPath);
  if (fromYaml === undefined || fromYaml === null) return fallback;
  return Boolean(fromYaml);
}

const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archives');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// 0o700 keeps the quiz database and its archives readable only by the account
// that runs the server, which matters on a shared department machine.
for (const dir of [DATA_DIR, ARCHIVE_DIR, BACKUP_DIR]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort: some filesystems (NFS, bind mounts) refuse chmod */
  }
}

/**
 * The secret that signs session cookies. Taken from the config file when set,
 * otherwise generated once and cached beside the database so that restarting
 * the server does not sign the instructor out.
 */
function resolveSessionSecret() {
  const configured = str('SESSION_SECRET', 'server.session_secret');
  if (configured && configured.length >= 32) return configured;

  const secretFile = path.join(DATA_DIR, '.session-secret');
  if (fs.existsSync(secretFile)) {
    const stored = fs.readFileSync(secretFile, 'utf8').trim();
    if (stored.length >= 32) return stored;
  }
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  return generated;
}

module.exports = {
  ROOT,
  CONFIG_DIR,
  CONFIG_FILE,
  EXAMPLE_FILE,
  PLACEHOLDER,
  isPlaceholder,
  readConfigFile,
  raw: file,
  configFileExists: fs.existsSync(CONFIG_FILE),

  DATA_DIR,
  ARCHIVE_DIR,
  BACKUP_DIR,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DB_FILE: path.join(DATA_DIR, 'tempoquiz.db'),

  PORT: int('PORT', 'server.port', 3000, 1, 65535),
  HOST: str('HOST', 'server.bind', '0.0.0.0'),

  // Where students reach the app. run.sh passes the live tunnel URL in through
  // the environment; left blank, the server infers it per request.
  PUBLIC_URL: str('PUBLIC_URL', 'server.public_url').replace(/\/+$/, ''),

  // ngrok terminates TLS and forwards over plain HTTP, so its proxy headers
  // are the only way to know the request really arrived over HTTPS.
  TRUST_PROXY: bool('TRUST_PROXY', 'server.trust_proxy', true),

  SESSION_SECRET: resolveSessionSecret(),
  SESSION_HOURS: int('SESSION_HOURS', 'server.session_hours', 12, 1, 720),

  NGROK_ENABLED: bool('NGROK_ENABLED', 'ngrok.enabled', true),
  NGROK_AUTHTOKEN: str('NGROK_AUTHTOKEN', 'ngrok.authtoken'),
  NGROK_DOMAIN: str('NGROK_DOMAIN', 'ngrok.domain').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  NGROK_REGION: str('NGROK_REGION', 'ngrok.region'),

  BOOTSTRAP_USERNAME: str('ADMIN_USERNAME', 'admin.username', 'admin'),
  BOOTSTRAP_PASSWORD: str('ADMIN_PASSWORD', 'admin.password'),

  BACKUP_INTERVAL_MIN: int('BACKUP_INTERVAL_MIN', 'backup.interval_minutes', 60, 0, 10080),
  BACKUP_KEEP: int('BACKUP_KEEP', 'backup.keep', 24, 1, 500),

  LOGIN_MAX_ATTEMPTS: int('LOGIN_MAX_ATTEMPTS', 'security.login_max_attempts', 8, 3, 100),
  LOGIN_WINDOW_MIN: int('LOGIN_WINDOW_MIN', 'security.login_window_minutes', 15, 1, 1440),

  MAX_PARTICIPANTS: int('MAX_PARTICIPANTS', 'quiz.max_participants', 400, 1, 5000),
  MAX_BODY_BYTES: int('MAX_BODY_BYTES', 'server.max_body_bytes', 512 * 1024, 4096, 8 * 1024 * 1024),

  ANSWER_GRACE_MS: int('ANSWER_GRACE_MS', 'quiz.answer_grace_ms', 1500, 0, 10000),
  READY_MS: 2000,
};
