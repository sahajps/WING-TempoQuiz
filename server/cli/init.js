'use strict';

/*
 * Config bootstrap and validation. Invoked by run.sh, not usually by hand.
 *
 *   node server/cli/init.js            create if missing, validate, explain
 *   node server/cli/init.js --check    validate quietly, exit code only
 *   node server/cli/init.js --export   emit shell assignments for run.sh
 *
 * Exit codes:  0 ready   2 needs editing   1 broken
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'tempoquiz.yml');
const EXAMPLE_FILE = path.join(CONFIG_DIR, 'tempoquiz.example.yml');
const LEGACY_ENV = path.join(ROOT, '.env');

const PLACEHOLDER = 'REPLACE_ME';
const mode = process.argv.includes('--export') ? 'export'
  : process.argv.includes('--check') ? 'check'
    : 'ensure';

const say = (...args) => {
  if (mode !== 'export') console.log(...args);
};
const rule = () => say('─'.repeat(68));

/** Reads a legacy .env so an existing install keeps its settings. */
function readLegacyEnv() {
  if (!fs.existsSync(LEGACY_ENV)) return null;
  const out = {};
  for (const line of fs.readFileSync(LEGACY_ENV, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Replaces a scalar in the YAML source textually rather than re-serialising,
 * so every comment in the template survives into the operator's copy.
 */
function setScalar(text, key, value, indent = '  ') {
  const pattern = new RegExp(`^(${indent}${key}:\\s*)(.*)$`, 'm');
  if (!pattern.test(text)) return text;
  // Numbers and booleans go in bare so they stay typed in YAML; anything else
  // is quoted, since tokens and secrets can contain YAML-significant
  // characters.
  const raw = String(value);
  const literal = /^(\d+|true|false)$/.test(raw) ? raw : `"${raw.replace(/"/g, '\\"')}"`;
  return text.replace(pattern, `$1${literal}`);
}

function createFromExample() {
  if (!fs.existsSync(EXAMPLE_FILE)) {
    console.error(`Missing template: ${EXAMPLE_FILE}`);
    console.error('The clone looks incomplete. Re-clone the repository.');
    process.exit(1);
  }

  let text = fs.readFileSync(EXAMPLE_FILE, 'utf8');

  // A real signing secret straight away; there is no reason to make anyone
  // think about this one.
  text = setScalar(text, 'session_secret', crypto.randomBytes(48).toString('base64url'));

  const legacy = readLegacyEnv();
  const carried = [];
  if (legacy) {
    if (legacy.SESSION_SECRET) {
      // Carrying this over keeps existing sign-ins valid across the upgrade.
      text = setScalar(text, 'session_secret', legacy.SESSION_SECRET);
      carried.push('server.session_secret');
    }
    if (legacy.PORT) {
      text = setScalar(text, 'port', legacy.PORT);
      carried.push('server.port');
    }
    if (legacy.PUBLIC_URL) {
      const host = legacy.PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (host.includes('ngrok')) {
        text = setScalar(text, 'domain', host);
        carried.push('ngrok.domain');
      } else {
        text = setScalar(text, 'public_url', legacy.PUBLIC_URL);
        carried.push('server.public_url');
      }
    }
    if (legacy.ADMIN_PASSWORD) {
      text = setScalar(text, 'password', legacy.ADMIN_PASSWORD);
      carried.push('admin.password');
    }
    if (legacy.ADMIN_USERNAME) {
      text = setScalar(text, 'username', legacy.ADMIN_USERNAME);
      carried.push('admin.username');
    }
  }

  // An authtoken already in the ngrok agent config is worth reusing rather
  // than making the operator hunt for it again.
  const agentConfig = path.join(
    process.env.HOME || '', '.config', 'ngrok', 'ngrok.yml',
  );
  if (fs.existsSync(agentConfig)) {
    try {
      const parsed = YAML.parse(fs.readFileSync(agentConfig, 'utf8')) || {};
      const token = parsed.authtoken || (parsed.agent && parsed.agent.authtoken);
      if (token) {
        text = setScalar(text, 'authtoken', token);
        carried.push('ngrok.authtoken (from your ngrok agent config)');
      }
    } catch {
      /* not fatal; the operator can paste it in */
    }
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, text, { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch { /* best effort */ }

  return carried;
}

function load() {
  let parsed;
  try {
    parsed = YAML.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch (error) {
    console.error(`\n${CONFIG_FILE} is not valid YAML.\n`);
    console.error(`  ${error.message}\n`);
    console.error('  Most often this is a tab character used for indentation');
    console.error('  (YAML requires spaces), or a value containing a colon');
    console.error('  that is not wrapped in "quotes".\n');
    process.exit(1);
  }
  return parsed;
}

const get = (cfg, dotted, fallback = '') => {
  const value = dotted.split('.').reduce(
    (node, key) => (node && typeof node === 'object' ? node[key] : undefined),
    cfg,
  );
  return value === undefined || value === null ? fallback : value;
};

const unset = (value) => value === '' || (typeof value === 'string' && value.trim().startsWith(PLACEHOLDER));

/**
 * True once the database holds an administrator. After that the password in
 * the config file is dead weight: the account is authoritative, and changes go
 * through ./run.sh passwd. Requiring it anyway would mean leaving a live
 * password sitting in a file for no reason.
 */
function adminAccountExists() {
  const dbFile = path.join(ROOT, process.env.DATA_DIR || 'data', 'tempoquiz.db');
  if (!fs.existsSync(dbFile)) return false;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const handle = new DatabaseSync(dbFile, { readOnly: true });
    const row = handle.prepare('SELECT COUNT(*) AS n FROM admin_account').get();
    handle.close();
    return Number(row.n) > 0;
  } catch {
    // No such table, or an unreadable file: treat as a first run.
    return false;
  }
}

/** Returns a list of human-readable problems; empty means ready to start. */
function validate(cfg, { accountExists = false } = {}) {
  const problems = [];

  const password = String(get(cfg, 'admin.password'));
  if (unset(password)) {
    // Only a blocker on a first run, when this is what creates the account.
    if (!accountExists) {
      problems.push({
        field: 'admin.password',
        message: 'still holds the placeholder from the template',
        fix: 'Set it to a password of at least 10 characters with a letter and a digit.\n'
           + '       This is used once, to create the console account.',
      });
    }
  } else if (accountExists) {
    // Not an error, but worth saying: editing it here changes nothing.
    problems.push({
      field: 'admin.password',
      level: 'note',
      message: 'is ignored — the console account already exists',
      fix: 'Change the password with ./run.sh passwd, then blank this line out.',
    });
  } else if (password.length < 10 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    problems.push({
      field: 'admin.password',
      message: 'is too weak',
      fix: 'Use at least 10 characters, including at least one letter and one digit.',
    });
  }

  const username = String(get(cfg, 'admin.username', 'admin'));
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
    problems.push({
      field: 'admin.username',
      message: 'is not a valid username',
      fix: 'Use 3-40 characters: letters, numbers, dot, dash or underscore.',
    });
  }

  if (get(cfg, 'ngrok.enabled', true)) {
    const token = String(get(cfg, 'ngrok.authtoken'));
    if (unset(token)) {
      problems.push({
        field: 'ngrok.authtoken',
        message: 'still holds the placeholder from the template',
        fix: 'Copy your free token from https://dashboard.ngrok.com/get-started/your-authtoken\n'
           + '       Or set ngrok.enabled: false to run on the local network only.',
      });
    }
  }

  const port = Number(get(cfg, 'server.port', 3000));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push({
      field: 'server.port',
      message: `is not a usable port (${get(cfg, 'server.port')})`,
      fix: 'Use a number between 1 and 65535, for example 3000.',
    });
  }

  const domain = String(get(cfg, 'ngrok.domain'));
  if (domain && !unset(domain)) {
    if (/^https?:\/\//.test(domain)) {
      problems.push({
        field: 'ngrok.domain',
        message: 'must not include https://',
        fix: `Write it as "${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}".`,
      });
    } else if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      problems.push({
        field: 'ngrok.domain',
        message: `does not look like a hostname (${domain})`,
        fix: 'It should look like "your-name.ngrok-free.app", or be left blank.',
      });
    }
  }

  return problems;
}

// --- run --------------------------------------------------------------------

let created = false;
let carriedOver = [];

if (!fs.existsSync(CONFIG_FILE)) {
  if (mode === 'export') {
    console.error('config/tempoquiz.yml does not exist');
    process.exit(2);
  }
  carriedOver = createFromExample();
  created = true;
}

const cfg = load();
const findings = validate(cfg, { accountExists: adminAccountExists() });
const problems = findings.filter((f) => f.level !== 'note');
const notes = findings.filter((f) => f.level === 'note');

if (mode === 'export') {
  if (problems.length) process.exit(2);
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const lines = [
    `TQ_PORT=${quote(get(cfg, 'server.port', 3000))}`,
    `TQ_BIND=${quote(get(cfg, 'server.bind', '0.0.0.0'))}`,
    `TQ_PUBLIC_URL=${quote(get(cfg, 'server.public_url', ''))}`,
    `TQ_NGROK_ENABLED=${quote(get(cfg, 'ngrok.enabled', true) ? '1' : '0')}`,
    `TQ_NGROK_TOKEN=${quote(get(cfg, 'ngrok.authtoken', ''))}`,
    `TQ_NGROK_DOMAIN=${quote(String(get(cfg, 'ngrok.domain', '')).replace(/^https?:\/\//, '').replace(/\/+$/, ''))}`,
    `TQ_NGROK_REGION=${quote(get(cfg, 'ngrok.region', ''))}`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

if (created) {
  rule();
  say('  Created config/tempoquiz.yml');
  rule();
  say('  This file holds your credentials. It is chmod 600 and is already');
  say('  listed in .gitignore, so git will not pick it up.');
  if (carriedOver.length) {
    say('');
    say('  Carried over from your existing setup:');
    carriedOver.forEach((field) => say(`    · ${field}`));
  }
  say('');
}

if (problems.length) {
  if (mode === 'check') process.exit(2);
  rule();
  const subject = problems.length === 1 ? 'One value needs' : `${problems.length} values need`;
  say(created ? `  ${subject} your attention` : `  ${subject} attention in the configuration`);
  rule();
  say('');
  for (const problem of problems) {
    say(`  ${problem.field}`);
    say(`     ${problem.message}`);
    say(`     → ${problem.fix}`);
    say('');
  }
  say(`  Edit:  ${path.relative(process.cwd(), CONFIG_FILE)}`);
  say('  Then:  ./run.sh');
  say('');
  process.exit(2);
}

if (mode === 'check') process.exit(0);

for (const note of notes) {
  say(`  Note: ${note.field} ${note.message}`);
  say(`        ${note.fix}`);
}

const domain = String(get(cfg, 'ngrok.domain', ''));
say(`  Configuration OK  ·  port ${get(cfg, 'server.port', 3000)}`
  + `  ·  ngrok ${get(cfg, 'ngrok.enabled', true) ? (domain || 'random URL') : 'disabled'}`);
process.exit(0);
