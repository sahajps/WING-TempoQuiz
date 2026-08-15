'use strict';

const express = require('express');

const service = require('../quiz-service');
const { asyncRoute, forbidden } = require('../util');
const { createRateLimiter } = require('../security');

const router = express.Router();

// Joining is the only student action worth throttling hard; polling is
// deliberately generous because every phone in the room does it on a timer.
const joinLimiter = createRateLimiter({ windowMs: 60_000, max: 30, name: 'join' });
const answerLimiter = createRateLimiter({ windowMs: 60_000, max: 240, name: 'answer' });

function playerTokenFrom(req) {
  return req.get('x-player-token') || (req.body && req.body.token) || null;
}

function loadParticipant(req, quiz) {
  const participant = service.participantFromToken(quiz, playerTokenFrom(req));
  if (!participant) {
    throw forbidden('Your place in this quiz was not recognised. Join the room again.');
  }
  return participant;
}

/** Public lobby summary, used before a student has joined. */
router.get('/:code', asyncRoute(async (req, res) => {
  const quiz = service.requireQuiz(req.params.code);
  res.json(service.lobbyState(quiz));
}));

router.post('/:code/join', joinLimiter, asyncRoute(async (req, res) => {
  const quiz = service.requireQuiz(req.params.code);
  const body = req.body || {};
  const { participant, token, rejoined } = service.joinQuiz(quiz, {
    nickname: body.nickname,
    studentId: body.studentId,
  });
  res.status(rejoined ? 200 : 201).json({
    ok: true,
    token,
    rejoined,
    nickname: participant.nickname,
    quiz: { code: quiz.code, name: quiz.name, status: quiz.status },
  });
}));

router.get('/:code/state', asyncRoute(async (req, res) => {
  const quiz = service.requireQuiz(req.params.code);
  const participant = loadParticipant(req, quiz);
  res.setHeader('Cache-Control', 'no-store');
  res.json(service.playerState(quiz, participant));
}));

router.post('/:code/answer', answerLimiter, asyncRoute(async (req, res) => {
  const quiz = service.requireQuiz(req.params.code);
  const participant = loadParticipant(req, quiz);
  const body = req.body || {};
  const result = service.submitAnswer(quiz, participant, {
    questionId: body.questionId,
    choiceIndex: body.choiceIndex,
  });
  // The result of the answer is withheld until the question closes, so that a
  // student cannot learn the correct option by submitting early.
  res.json({ ok: true, accepted: result.accepted, msTaken: result.msTaken });
}));

module.exports = router;
