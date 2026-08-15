'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreAnswer, rankParticipants, BASE_POINTS } = require('../server/scoring');

test('a wrong answer scores nothing, however fast', () => {
  assert.equal(scoreAnswer(false, 0, 20), 0);
  assert.equal(scoreAnswer(false, 19_000, 20), 0);
});

test('an instant correct answer scores the full 1000', () => {
  assert.equal(scoreAnswer(true, 0, 20), 1000);
});

test('a correct answer at the buzzer still scores the base 500', () => {
  assert.equal(scoreAnswer(true, 20_000, 20), BASE_POINTS);
});

test('speed points fall linearly across the window', () => {
  assert.equal(scoreAnswer(true, 10_000, 20), 750);
  assert.equal(scoreAnswer(true, 5_000, 20), 875);
  assert.equal(scoreAnswer(true, 15_000, 20), 625);
});

test('answering after the window never scores below the base', () => {
  assert.equal(scoreAnswer(true, 999_999, 20), BASE_POINTS);
});

test('a negative or missing elapsed time is treated as instant', () => {
  assert.equal(scoreAnswer(true, -50, 20), 1000);
  assert.equal(scoreAnswer(true, NaN, 20), 1000);
});

test('ranks by score, then by total time taken', () => {
  const ranked = rankParticipants([
    { nickname: 'Slow', score: 900, total_ms: 9000 },
    { nickname: 'Fast', score: 900, total_ms: 3000 },
    { nickname: 'Top', score: 1500, total_ms: 8000 },
  ]);
  assert.deepEqual(ranked.map((r) => r.nickname), ['Top', 'Fast', 'Slow']);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3]);
});

test('equal scores and equal times share a rank, and the next rank skips', () => {
  const ranked = rankParticipants([
    { nickname: 'A', score: 1000, total_ms: 100 },
    { nickname: 'B', score: 1000, total_ms: 100 },
    { nickname: 'C', score: 500, total_ms: 100 },
  ]);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 1, 3]);
});

test('ordering is stable for identical rows', () => {
  const rows = [
    { nickname: 'Zoe', score: 100, total_ms: 10 },
    { nickname: 'Amy', score: 100, total_ms: 10 },
  ];
  assert.deepEqual(rankParticipants(rows).map((r) => r.nickname), ['Amy', 'Zoe']);
  assert.deepEqual(rankParticipants(rows).map((r) => r.nickname), ['Amy', 'Zoe']);
});

test('ranking does not mutate the rows it was given', () => {
  const rows = [{ nickname: 'A', score: 1, total_ms: 1 }];
  rankParticipants(rows);
  assert.equal('rank' in rows[0], false);
});
