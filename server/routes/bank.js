'use strict';

const express = require('express');

const bank = require('../bank');
const auth = require('../auth');
const md = require('../markdown');
const { asyncRoute, badRequest } = require('../util');
const { requireCsrf } = require('../security');

const router = express.Router();

// The question bank is instructor-only in its entirety.
router.use(auth.requireAdmin);

router.get('/questions', asyncRoute(async (req, res) => {
  const filters = {
    topic: req.query.topic || undefined,
    difficulty: req.query.difficulty || undefined,
    status: req.query.status || undefined,
    search: req.query.search || undefined,
    includeRetired: req.query.includeRetired === 'true',
    limit: req.query.limit,
    offset: req.query.offset,
  };
  res.json({
    questions: bank.listQuestions(filters),
    total: bank.countQuestions(filters),
    stats: bank.stats(),
  });
}));

router.get('/questions/:id', asyncRoute(async (req, res) => {
  const question = bank.getQuestion(Number(req.params.id));
  if (!question) throw badRequest('That question is not in the bank.');
  res.json({ question, history: bank.usageHistory(question.id) });
}));

router.post('/questions', requireCsrf, asyncRoute(async (req, res) => {
  res.status(201).json({ ok: true, question: bank.createQuestion(req.body || {}) });
}));

router.patch('/questions/:id', requireCsrf, asyncRoute(async (req, res) => {
  res.json({ ok: true, question: bank.updateQuestion(Number(req.params.id), req.body || {}) });
}));

router.post('/questions/:id/retire', requireCsrf, asyncRoute(async (req, res) => {
  const retired = (req.body || {}).retired !== false;
  res.json({ ok: true, question: bank.setRetired(Number(req.params.id), retired) });
}));

router.delete('/questions/:id', requireCsrf, asyncRoute(async (req, res) => {
  bank.deleteQuestion(Number(req.params.id));
  res.json({ ok: true });
}));

router.get('/topics', asyncRoute(async (_req, res) => {
  res.json({ topics: bank.topics() });
}));

router.get('/stats', asyncRoute(async (_req, res) => {
  res.json({ stats: bank.stats() });
}));

router.post('/import', requireCsrf, asyncRoute(async (req, res) => {
  const { markdown, topic, difficulty } = req.body || {};
  if (!markdown || !String(markdown).trim()) throw badRequest('Paste some Markdown to import.');
  const result = bank.importMarkdown(markdown, { topic, difficulty });
  res.json({
    ok: true,
    added: result.added.length,
    duplicates: result.duplicates,
    total: result.total,
    questions: result.added,
  });
}));

router.get('/export', asyncRoute(async (req, res) => {
  const topic = req.query.topic || undefined;
  const markdown = bank.exportMarkdown({ topic, includeRetired: req.query.includeRetired === 'true' });
  const name = topic ? `question-bank-${topic.replace(/[^a-z0-9]+/gi, '-')}` : 'question-bank';
  res.type('text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.md"`);
  res.send(markdown);
}));

/** Random draw of questions no class has seen yet. */
router.post('/draw', requireCsrf, asyncRoute(async (req, res) => {
  const { topic, difficulty, count } = req.body || {};
  const questions = bank.draw({ topic, difficulty, count });
  res.json({
    questions,
    requested: Number(count) || 5,
    shortfall: Math.max(0, (Number(count) || 5) - questions.length),
    stats: bank.stats(),
  });
}));

/**
 * Checks pasted Markdown against the bank and reports which questions a class
 * has already been asked. Read-only: nothing is stored.
 */
router.post('/check-reuse', requireCsrf, asyncRoute(async (req, res) => {
  const { markdown } = req.body || {};
  if (!markdown || !String(markdown).trim()) throw badRequest('Paste some Markdown to check.');
  const parsed = md.parseQuiz(markdown, { requireTitle: false });
  if (parsed.errors.length) {
    res.json({ ok: false, errors: parsed.errors, matches: [] });
    return;
  }
  const matches = bank.checkReuse(parsed.questions);
  res.json({
    ok: true,
    errors: [],
    matches,
    repeatedCount: matches.filter((m) => m.used).length,
  });
}));

module.exports = router;
