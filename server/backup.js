'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const { getDb } = require('./db');

/**
 * Takes a consistent snapshot of the live database.
 *
 * VACUUM INTO reads through SQLite itself rather than copying bytes, so it is
 * safe to run while a quiz is in progress: the snapshot is a complete,
 * already-compacted database with no separate WAL to carry along.
 */
function createBackup(label = 'auto') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeLabel = String(label).replace(/[^a-z0-9_-]/gi, '') || 'auto';
  const target = path.join(config.BACKUP_DIR, `tempoquiz-${stamp}-${safeLabel}.db`);

  getDb().exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    /* best effort */
  }
  return { file: target, bytes: fs.statSync(target).size, at: new Date().toISOString() };
}

function listBackups() {
  if (!fs.existsSync(config.BACKUP_DIR)) return [];
  return fs
    .readdirSync(config.BACKUP_DIR)
    .filter((name) => name.endsWith('.db'))
    .map((name) => {
      const full = path.join(config.BACKUP_DIR, name);
      const stat = fs.statSync(full);
      return { name, bytes: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Keeps the newest BACKUP_KEEP snapshots and removes the rest. */
function pruneBackups(keep = config.BACKUP_KEEP) {
  const all = listBackups();
  const removed = [];
  for (const entry of all.slice(keep)) {
    try {
      fs.unlinkSync(path.join(config.BACKUP_DIR, entry.name));
      removed.push(entry.name);
    } catch {
      /* leave it for the next sweep */
    }
  }
  return removed;
}

let timer = null;

/** Snapshots at startup, then on an interval. Disabled when the interval is 0. */
function startScheduler() {
  if (config.BACKUP_INTERVAL_MIN <= 0) return null;

  const run = (label) => {
    try {
      const result = createBackup(label);
      pruneBackups();
      console.log(`[backup] ${path.basename(result.file)} (${(result.bytes / 1024).toFixed(0)} KB)`);
    } catch (error) {
      console.error('[backup] failed:', error.message);
    }
  };

  run('startup');
  timer = setInterval(() => run('auto'), config.BACKUP_INTERVAL_MIN * 60_000);
  // Do not hold the event loop open just for backups.
  if (timer.unref) timer.unref();
  return timer;
}

function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { createBackup, listBackups, pruneBackups, startScheduler, stopScheduler };
