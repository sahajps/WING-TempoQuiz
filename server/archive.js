'use strict';

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const { slugify } = require('./util');

/**
 * On-disk JSON record of a quiz, kept alongside the database.
 *
 * Files are grouped by the date the quiz was created and named after the quiz,
 * so `data/archives/2026-08-13/week-3-retrieval__H7K2QP.json` is readable
 * without opening the database. The room code is part of the filename because
 * two quizzes can legitimately share a name on the same day.
 */
function archivePathFor(quiz) {
  const dateDir = String(quiz.created_date || quiz.createdDate).slice(0, 10);
  const slug = slugify(quiz.slug || quiz.name);
  return path.join(dateDir, `${slug}__${quiz.code}.json`);
}

function absolutePath(relative) {
  const resolved = path.resolve(config.ARCHIVE_DIR, relative);
  // Guard against a crafted quiz name escaping the archive directory.
  if (resolved !== config.ARCHIVE_DIR && !resolved.startsWith(config.ARCHIVE_DIR + path.sep)) {
    throw new Error('Refusing to write an archive outside the archive directory');
  }
  return resolved;
}

/** Writes the record atomically so a crash cannot leave a half-written file. */
function writeArchive(quiz, payload) {
  const relative = archivePathFor(quiz);
  const target = absolutePath(relative);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });

  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
  return relative;
}

function readArchive(relative) {
  const target = absolutePath(relative);
  if (!fs.existsSync(target)) return null;
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

function deleteArchive(relative) {
  if (!relative) return false;
  try {
    const target = absolutePath(relative);
    if (!fs.existsSync(target)) return false;
    fs.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Lists archive files newest first, for the admin archive browser. */
function listArchives() {
  const out = [];
  if (!fs.existsSync(config.ARCHIVE_DIR)) return out;
  for (const dateDir of fs.readdirSync(config.ARCHIVE_DIR)) {
    const dirPath = path.join(config.ARCHIVE_DIR, dateDir);
    let stat;
    try {
      stat = fs.statSync(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(dirPath, file);
      const fileStat = fs.statSync(full);
      out.push({
        path: path.join(dateDir, file),
        date: dateDir,
        file,
        bytes: fileStat.size,
        modified: fileStat.mtime.toISOString(),
      });
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

module.exports = { archivePathFor, writeArchive, readArchive, deleteArchive, listArchives };
