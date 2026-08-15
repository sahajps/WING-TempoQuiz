'use strict';

const express = require('express');

const config = require('../config');
const auth = require('../auth');
const backup = require('../backup');
const bank = require('../bank');
const quizzes = require('../quiz-service');
const archive = require('../archive');
const { query, integrityCheck } = require('../db');
const { asyncRoute, HttpError, badRequest } = require('../util');
const { createRateLimiter, requireCsrf } = require('../security');

const router = express.Router();

const loginLimiter = createRateLimiter({
  windowMs: 10 * 60_000,
  max: 30,
  name: 'sign-in',
});

router.post('/login', loginLimiter, asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const admin = auth.authenticate({ username, password, ip: req.ip });
  const session = auth.createSession(req, res);
  res.json({
    ok: true,
    username: admin.username,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    mustChangePassword: Boolean(admin.must_change),
  });
}));

router.post('/logout', asyncRoute(async (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
}));

router.get('/session', asyncRoute(async (req, res) => {
  if (!req.adminSession) {
    res.json({ authenticated: false });
    return;
  }
  const admin = auth.getAdmin();
  res.json({
    authenticated: true,
    username: admin ? admin.username : null,
    mustChangePassword: Boolean(admin && admin.must_change),
    expiresAt: req.adminSession.expires_at,
    // Re-issued so a tab opened fresh against an existing cookie can act
    // straight away. Same-origin policy stops another site reading this.
    csrfToken: req.adminSession.csrf_token,
  });
}));

/**
 * Changing credentials always requires the current password, so a borrowed
 * browser session cannot be used to lock the real owner out.
 */
router.post('/credentials', auth.requireAdmin, requireCsrf, asyncRoute(async (req, res) => {
  const { currentPassword, username, newPassword } = req.body || {};
  const admin = auth.getAdmin();
  if (!admin) throw new HttpError(500, 'No administrator account exists.');
  if (!auth.verifyPassword(String(currentPassword ?? ''), admin.password_hash, admin.password_salt)) {
    throw new HttpError(401, 'Your current password is not correct.');
  }
  auth.setCredentials({
    username: username || admin.username,
    password: newPassword,
  });
  // Every other session is invalidated; the caller gets a fresh one.
  auth.destroyAllSessions();
  const session = auth.createSession(req, res);
  res.json({ ok: true, csrfToken: session.csrfToken, username: (username || admin.username).trim() });
}));

router.use(auth.requireAdmin);

router.get('/health', asyncRoute(async (_req, res) => {
  const counts = query.get(`
    SELECT (SELECT COUNT(*) FROM quiz) AS quizzes,
           (SELECT COUNT(*) FROM quiz WHERE status = 'running') AS running,
           (SELECT COUNT(*) FROM bank_question) AS bank_questions,
           (SELECT COUNT(*) FROM participant) AS participants,
           (SELECT COUNT(*) FROM answer) AS answers,
           (SELECT COUNT(*) FROM admin_session) AS sessions
  `);
  const backups = backup.listBackups();
  res.json({
    ok: true,
    integrity: integrityCheck(),
    counts: {
      quizzes: Number(counts.quizzes),
      running: Number(counts.running),
      bankQuestions: Number(counts.bank_questions),
      participants: Number(counts.participants),
      answers: Number(counts.answers),
      sessions: Number(counts.sessions),
    },
    bank: bank.stats(),
    backups: {
      count: backups.length,
      latest: backups[0] || null,
      keep: config.BACKUP_KEEP,
      intervalMinutes: config.BACKUP_INTERVAL_MIN,
    },
    archives: archive.listArchives().length,
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
  });
}));

router.post('/backup', requireCsrf, asyncRoute(async (_req, res) => {
  const result = backup.createBackup('manual');
  backup.pruneBackups();
  res.json({ ok: true, backup: { ...result, file: result.file.split('/').pop() } });
}));

router.get('/backups', asyncRoute(async (_req, res) => {
  res.json({ backups: backup.listBackups() });
}));

router.get('/archives', asyncRoute(async (_req, res) => {
  res.json({ archives: archive.listArchives() });
}));

router.get('/quizzes', asyncRoute(async (req, res) => {
  res.json({ quizzes: quizzes.listQuizzes({ status: req.query.status, limit: req.query.limit }) });
}));

router.get('/quizzes/:id/record', asyncRoute(async (req, res) => {
  const quiz = quizzes.getQuizById(Number(req.params.id));
  if (!quiz) throw new HttpError(404, 'That quiz no longer exists.');
  res.json(quizzes.buildRecord(quiz));
}));

/**
 * Re-issues the host token. Used when an instructor closes the host tab and
 * loses the token that was only shown once.
 */
router.post('/quizzes/:id/host-token', requireCsrf, asyncRoute(async (req, res) => {
  const quiz = quizzes.getQuizById(Number(req.params.id));
  if (!quiz) throw new HttpError(404, 'That quiz no longer exists.');
  const hostToken = quizzes.rotateHostToken(quiz);
  res.json({ ok: true, code: quiz.code, hostToken });
}));

router.delete('/quizzes/:id', requireCsrf, asyncRoute(async (req, res) => {
  const deleteArchiveFile = req.query.archive === 'delete';
  quizzes.deleteQuiz(Number(req.params.id), { deleteArchiveFile });
  res.json({ ok: true });
}));

router.post('/sessions/revoke', requireCsrf, asyncRoute(async (req, res) => {
  auth.destroyAllSessions();
  const session = auth.createSession(req, res);
  res.json({ ok: true, csrfToken: session.csrfToken });
}));

router.post('/maintenance', requireCsrf, asyncRoute(async (req, res) => {
  const action = String((req.body || {}).action || '');
  if (action === 'purge-sessions') {
    res.json({ ok: true, removed: auth.purgeExpiredSessions() });
    return;
  }
  if (action === 'prune-backups') {
    res.json({ ok: true, removed: backup.pruneBackups() });
    return;
  }
  throw badRequest('Unknown maintenance action.');
}));

module.exports = router;
