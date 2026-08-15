'use strict';

// Takes an immediate database snapshot:  npm run backup

const db = require('../db');
const backup = require('../backup');

db.migrate();
const result = backup.createBackup('manual');
const removed = backup.pruneBackups();

console.log(`Backup written: ${result.file}`);
console.log(`Size: ${(result.bytes / 1024).toFixed(0)} KB`);
if (removed.length) console.log(`Pruned ${removed.length} older snapshot(s).`);
console.log(`Snapshots kept: ${backup.listBackups().length}`);
db.close();
