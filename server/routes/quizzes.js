'use strict';

const express = require('express');
const QRCode = require('qrcode');

const service = require('../quiz-service');
const bank = require('../bank');
const md = require('../markdown');
const auth = require('../auth');
const { asyncRoute, badRequest, forbidden } = require('../util');
const { requireCsrf, publicBaseUrl, createRateLimiter } = require('../security');

const router = express.Router();

const createLimiter = createRateLimiter({ windowMs: 60_000, max: 20, name: 'quiz creation' });

/** Host token may arrive in a header (for GETs) or the JSON body (for POSTs). */
function hostTokenFrom(req) {
  return req.get('x-host-token') || (req.body && req.body.hostToken) || req.query.hostToken || null;
}

/**
 * CSRF applies to the session cookie, which a browser attaches automatically,
 * but not to a host token, which a caller must supply deliberately. So a
 * request carrying a host token is exempt, and a cookie-authenticated one is
 * not — which keeps the scripted API usable without weakening the console.
 */
function csrfUnlessHostToken(req, res, next) {
  if (hostTokenFrom(req)) {
    next();
    return;
  }
  requireCsrf(req, res, next);
}

/**
 * A quiz may be driven either by a signed-in administrator or by whoever holds
 * the host token, which is what makes the documented API usable from a script
 * without a browser session.
 */
function loadQuizForHost(req) {
  const quiz = service.requireQuiz(req.params.code);
  if (req.adminSession) return quiz;
  const token = hostTokenFrom(req);
  if (!token) {
    throw forbidden('Sign in as the administrator, or supply the host token for this quiz.');
  }
  return service.requireHost(quiz, token);
}

/** Validates Markdown without saving anything; powers the editor's live notes. */
router.post('/validate', asyncRoute(async (req, res) => {
  const { markdown, requireTitle = true } = req.body || {};
  const parsed = md.parseQuiz(markdown || '', { requireTitle: requireTitle !== false });
  let reuse = [];
  // Only a signed-in instructor may see whether a question has been asked before.
  if (req.adminSession && parsed.questions.length) {
    reuse = bank.checkReuse(parsed.questions);
  }
  res.json({
    ok: parsed.ok,
    title: parsed.title,
    errors: parsed.errors,
    questionCount: parsed.questions.length,
    totalSeconds: parsed.questions.reduce((sum, q) => sum + (q.timeLimit || 0), 0),
    reuse,
    repeatedCount: reuse.filter((entry) => entry.used).length,
  });
}));

/**
 * Creates a quiz from pasted Markdown or from a list of bank question ids.
 * Responds with the room code and the host token, which is shown exactly once.
 */
router.post('/', createLimiter, csrfUnlessHostToken, asyncRoute(async (req, res) => {
  const body = req.body || {};
  // Creating a quiz from the bank exposes bank contents, so it needs a session.
  if (Array.isArray(body.questionIds) && body.questionIds.length) {
    if (!req.adminSession) throw forbidden('Sign in as the administrator to build a quiz from the bank.');
    const { quiz, hostToken } = service.createFromBank({
      name: body.name,
      questionIds: body.questionIds,
      allowUsed: body.allowUsed === true,
    });
    res.status(201).json({ ok: true, code: quiz.code, name: quiz.name, hostToken, questionCount: body.questionIds.length });
    return;
  }

  if (!body.markdown || !String(body.markdown).trim()) {
    throw badRequest('Paste the quiz Markdown, or pick questions from the bank.');
  }

  const { quiz, hostToken } = service.createFromMarkdown({
    markdown: body.markdown,
    name: body.name,
    // Only a signed-in instructor may write into the shared bank.
    addToBank: Boolean(req.adminSession) && body.addToBank !== false,
  });
  res.status(201).json({
    ok: true,
    code: quiz.code,
    name: quiz.name,
    hostToken,
    questionCount: service.questionsFor(quiz.id).length,
  });
}));

router.get('/:code/host', asyncRoute(async (req, res) => {
  const quiz = loadQuizForHost(req);
  const state = service.hostState(quiz);
  state.joinUrl = `${publicBaseUrl(req)}/join/${quiz.code}`;
  res.json(state);
}));

/** QR code for the student join URL, as a scalable SVG. */
router.get('/:code/qr.svg', asyncRoute(async (req, res) => {
  const quiz = service.requireQuiz(req.params.code);
  const url = `${publicBaseUrl(req)}/join/${quiz.code}`;
  const svg = await QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 1,
    color: { dark: '#1b2a4a', light: '#ffffff' },
  });
  res.type('image/svg+xml');
  res.setHeader('Cache-Control', 'no-store');
  res.send(svg);
}));

router.post('/:code/append', csrfUnlessHostToken, asyncRoute(async (req, res) => {
  const quiz = loadQuizForHost(req);
  const body = req.body || {};
  const result = service.appendQuestions(quiz, {
    markdown: body.markdown,
    expectedQuestionCount: body.expectedQuestionCount,
    addToBank: Boolean(req.adminSession) && body.addToBank !== false,
  });
  res.json({ ok: true, ...result });
}));

/**
 * Opens the room to students. A quiz is prepared in advance and sits closed
 * until this is called, so the code cannot be joined before the lecture.
 */
router.post('/:code/open', csrfUnlessHostToken, asyncRoute(async (req, res) => {
  const quiz = loadQuizForHost(req);
  const opened = service.openRoom(quiz);
  res.json({ ok: true, open: true, openedAt: opened.opened_at });
}));

/**
 * Shuts the room again. Named for symmetry with /open; plain /close already
 * means "close the question that is currently running".
 */
router.post('/:code/close-room', csrfUnlessHostToken, asyncRoute(async (req, res) => {
  const quiz = loadQuizForHost(req);
  service.closeRoom(quiz);
  res.json({ ok: true, open: false });
}));

router.post('/:code/release', csrfUnlessHostToken, asyncRoute(async (req, res) => {
  const quiz = loadQuizForHost(req);
  const result = service.releaseNext(quiz);
  res.json({ ok: true, ...result });
}));

router.post('/:code/close', csrfUnlessHostToken, asyncRoute(async (req, res) => {
  const quiz = loadQuizForHost(req);
  service.closeCurrent(quiz);
  res.json({ ok: true });
}));

router.post('/:code/finish', csrfUnlessHostToken, asyncRoute(async (req, res) => {
  const quiz = loadQuizForHost(req);
  const finished = service.finishQuiz(quiz);
  res.json({ ok: true, status: finished.status, finishedAt: finished.finished_at });
}));

/** Pushes one question onto every student screen for class review. */
router.post('/:code/review', csrfUnlessHostToken, asyncRoute(async (req, res) => {
  const quiz = loadQuizForHost(req);
  const position = (req.body || {}).position;
  const question = service.setReview(quiz, position === undefined ? null : position);
  res.json({ ok: true, position: question ? question.position : null });
}));

/**
 * Exports stay a POST so the host token travels in the request body rather
 * than a URL that would be written to browser history and server logs.
 */
router.post('/:code/export', csrfUnlessHostToken, asyncRoute(async (req, res) => {
  const quiz = loadQuizForHost(req);
  const format = String((req.body || {}).format || 'json').toLowerCase();
  const stamp = quiz.created_date;
  const base = `${quiz.slug}-${quiz.code}-${stamp}`;

  if (format === 'markdown' || format === 'md') {
    res.type('text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.md"`);
    res.send(service.exportMarkdown(quiz));
    return;
  }
  if (format === 'csv') {
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
    res.send(service.exportCsv(quiz));
    return;
  }
  if (format === 'json') {
    res.type('application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
    res.send(JSON.stringify(service.buildRecord(quiz), null, 2));
    return;
  }
  throw badRequest('Format must be markdown, csv or json.');
}));

module.exports = router;
