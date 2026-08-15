'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const config = require('./config');

let db = null;
let txDepth = 0;

/**
 * Restricts the database and its write-ahead log to the owning user. SQLite
 * creates -wal and -shm siblings on demand, so this runs after every open.
 */
function lockDownFiles() {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${config.DB_FILE}${suffix}`;
    if (!fs.existsSync(file)) continue;
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort on filesystems that do not support chmod */
    }
  }
}

function applyPragmas(handle) {
  // WAL lets the host dashboard read while students are writing answers,
  // instead of the two blocking each other during a live quiz.
  handle.exec('PRAGMA journal_mode = WAL');
  // NORMAL is the documented safe pairing with WAL: a crash cannot corrupt the
  // database, at worst the last transaction or two are lost.
  handle.exec('PRAGMA synchronous = NORMAL');
  handle.exec('PRAGMA foreign_keys = ON');
  // A whole class submitting at once produces brief write contention; wait
  // rather than immediately returning SQLITE_BUSY.
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA temp_store = MEMORY');
}

function getDb() {
  if (db) return db;
  db = new DatabaseSync(config.DB_FILE);
  applyPragmas(db);
  lockDownFiles();
  return db;
}

function migrate() {
  const handle = getDb();

  // admin_session used to keep a hash of the CSRF token, which meant a newly
  // opened tab could not be handed the token again. Sessions are disposable,
  // so the safe migration is to drop the old table and let it be recreated:
  // the only cost is that anyone signed in has to sign in once more.
  const sessionColumns = handle.prepare('PRAGMA table_info(admin_session)').all();
  if (sessionColumns.some((column) => column.name === 'csrf_hash')) {
    handle.exec('DROP TABLE admin_session');
  }

  // The identifier column was originally named for one university. Renaming it
  // in place keeps every existing participant row and its answers intact;
  // SQLite carries the UNIQUE constraint across the rename.
  const participantColumns = handle.prepare('PRAGMA table_info(participant)').all();
  if (participantColumns.some((column) => column.name === 'nus_suffix')) {
    handle.exec('ALTER TABLE participant RENAME COLUMN nus_suffix TO student_id');
  }

  // Rooms used to be joinable from the moment the quiz was created. Quizzes
  // that already exist were all open, so they are backfilled as such — only
  // quizzes made from now on start closed and wait to be opened.
  const quizColumns = handle.prepare('PRAGMA table_info(quiz)').all();
  if (quizColumns.length && !quizColumns.some((column) => column.name === 'opened_at')) {
    handle.exec('ALTER TABLE quiz ADD COLUMN opened_at TEXT');
    handle.exec('UPDATE quiz SET opened_at = created_at WHERE opened_at IS NULL');
  }

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  handle.exec(schema);

  const row = handle
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get();
  if (!row) {
    handle
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')")
      .run();
  }
  lockDownFiles();
  return handle;
}

const query = {
  /** Returns every matching row as a plain object. */
  all(sql, ...params) {
    return getDb().prepare(sql).all(...params).map(toPlain);
  },
  /** Returns the first matching row, or undefined. */
  get(sql, ...params) {
    const row = getDb().prepare(sql).get(...params);
    return row === undefined ? undefined : toPlain(row);
  },
  /** Executes a statement and returns { changes, lastInsertRowid }. */
  run(sql, ...params) {
    return getDb().prepare(sql).run(...params);
  },
  exec(sql) {
    return getDb().exec(sql);
  },
};

/**
 * node:sqlite hands back null-prototype objects, which behave surprisingly
 * with instanceof and JSON tooling. Copy them into ordinary objects.
 */
function toPlain(row) {
  return row === null || row === undefined ? row : { ...row };
}

/**
 * Runs fn inside a transaction, rolling back if it throws. Nested calls join
 * the outer transaction via savepoints so helpers stay composable.
 */
function transaction(fn) {
  const handle = getDb();
  if (txDepth > 0) {
    const name = `sp_${txDepth}`;
    handle.exec(`SAVEPOINT ${name}`);
    txDepth += 1;
    try {
      const result = fn();
      handle.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      handle.exec(`ROLLBACK TO ${name}`);
      handle.exec(`RELEASE ${name}`);
      throw error;
    } finally {
      txDepth -= 1;
    }
  }

  handle.exec('BEGIN IMMEDIATE');
  txDepth = 1;
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      /* the transaction was already rolled back by SQLite */
    }
    throw error;
  } finally {
    txDepth = 0;
  }
}

/** Verifies structural integrity; surfaced in the admin health panel. */
function integrityCheck() {
  const row = getDb().prepare('PRAGMA integrity_check').get();
  return row ? Object.values(row)[0] : 'unknown';
}

function close() {
  if (db) {
    try {
      // Fold the write-ahead log back into the main file so a copied .db is
      // complete on its own.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* nothing useful to do while shutting down */
    }
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  migrate,
  query,
  transaction,
  integrityCheck,
  lockDownFiles,
  close,
};
