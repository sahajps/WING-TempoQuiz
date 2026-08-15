'use strict';

// Every test file requires this FIRST, before anything that reads config, so
// the suite works against a throwaway data directory and never touches the
// real tempoquiz.db.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempoquiz-test-'));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = 'test-secret-that-is-long-enough-to-be-accepted';
process.env.ADMIN_USERNAME = 'tester';
process.env.ADMIN_PASSWORD = 'testpassword1';
// Automatic snapshots would only add noise and files during a test run.
process.env.BACKUP_INTERVAL_MIN = '0';

function cleanup() {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the OS will reclaim the temp directory anyway */
  }
}

process.on('exit', cleanup);

module.exports = { DATA_DIR: dir, cleanup };
