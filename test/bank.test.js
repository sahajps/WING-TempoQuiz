'use strict';

require('./helper');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../server/db');
const bank = require('../server/bank');
const quizzes = require('../server/quiz-service');

db.migrate();

function reset() {
  db.query.exec('DELETE FROM bank_usage; DELETE FROM answer; DELETE FROM participant; DELETE FROM quiz_question; DELETE FROM quiz; DELETE FROM bank_question;');
}

function sample(prompt, extra = {}) {
  return {
    prompt,
    topic: 'Retrieval',
    timeLimit: 20,
    options: [{ text: 'A', correct: true }, { text: 'B' }, { text: 'C' }, { text: 'D' }],
    ...extra,
  };
}

test('stores and reads back a question', () => {
  reset();
  const created = bank.createQuestion(sample('What is an inverted index?'));
  assert.equal(created.status, 'available');
  assert.equal(created.answerIndex, 0);
  assert.equal(created.options.length, 4);
  assert.equal(bank.getQuestion(created.id).prompt, 'What is an inverted index?');
});

test('treats differently formatted duplicates as the same question', () => {
  reset();
  bank.createQuestion(sample('What is an inverted index?'));
  for (const variant of [
    'what is an inverted index?',
    'What  is   an inverted index!',
    'What is an INVERTED index',
  ]) {
    assert.throws(
      () => bank.createQuestion(sample(variant)),
      (error) => error.status === 409,
      `"${variant}" should be recognised as a duplicate`,
    );
  }
});

test('option order does not affect duplicate detection', () => {
  reset();
  bank.createQuestion(sample('Pick one'));
  assert.throws(() => bank.createQuestion({
    prompt: 'Pick one',
    timeLimit: 20,
    options: [{ text: 'D' }, { text: 'C' }, { text: 'B' }, { text: 'A', correct: true }],
  }), (error) => error.status === 409);
});

test('rejects malformed questions with a specific message', () => {
  reset();
  assert.throws(() => bank.createQuestion(sample('Q', { options: [{ text: 'A', correct: true }, { text: 'B' }] })),
    /between 4 and 6/);
  assert.throws(() => bank.createQuestion(sample('Q', { timeLimit: 2 })), /between 10 and 600/);
  assert.throws(() => bank.createQuestion(sample('Q', { difficulty: 'impossible' })), /easy, medium or hard/);
  assert.throws(() => bank.createQuestion(sample('Q', { imageUrl: 'javascript:alert(1)' })), /not allowed/);
  assert.throws(() => bank.createQuestion(sample('Q', { imageUrl: 'https://x.test/a.png' })), /alt text is required/);
  assert.throws(() => bank.createQuestion(sample('Q', {
    options: [{ text: 'A', correct: true }, { text: 'B', correct: true }, { text: 'C' }, { text: 'D' }],
  })), /only one option/i);
});

test('a question becomes used only once it is released to a class', () => {
  reset();
  const q = bank.createQuestion(sample('Released question'));
  const { quiz } = quizzes.createQuiz({ name: 'Week 1', questions: [{ ...q, bankId: q.id }], addToBank: false });

  assert.equal(bank.getQuestion(q.id).status, 'reserved', 'in a quiz but not yet shown');
  assert.equal(bank.getQuestion(q.id).useCount, 0);

  quizzes.releaseNext(quiz);
  assert.equal(bank.getQuestion(q.id).status, 'used');
  assert.equal(bank.getQuestion(q.id).useCount, 1);
});

test('drawing excludes used, reserved and retired questions', () => {
  reset();
  const fresh = bank.createQuestion(sample('Fresh one'));
  const willUse = bank.createQuestion(sample('Will be used'));
  const willReserve = bank.createQuestion(sample('Will be reserved'));
  const retired = bank.createQuestion(sample('Retired one'));
  bank.setRetired(retired.id, true);

  const { quiz } = quizzes.createQuiz({
    name: 'Week 1',
    questions: [{ ...willUse, bankId: willUse.id }],
    addToBank: false,
  });
  quizzes.releaseNext(quiz);
  quizzes.createQuiz({
    name: 'Week 2',
    questions: [{ ...willReserve, bankId: willReserve.id }],
    addToBank: false,
  });

  const drawn = bank.draw({ count: 10 }).map((q) => q.id);
  assert.deepEqual(drawn, [fresh.id], 'only the untouched question may be drawn');
});

test('a draw short of the requested count returns what it has', () => {
  reset();
  bank.createQuestion(sample('Only one'));
  const drawn = bank.draw({ count: 5 });
  assert.equal(drawn.length, 1);
});

test('usage history survives deleting the quiz that used the question', () => {
  reset();
  const q = bank.createQuestion(sample('Durable question'));
  const { quiz } = quizzes.createQuiz({ name: 'Week 9', questions: [{ ...q, bankId: q.id }], addToBank: false });
  quizzes.releaseNext(quiz);
  quizzes.deleteQuiz(quiz.id);

  const after = bank.getQuestion(q.id);
  assert.equal(after.status, 'used', 'the class still saw it, so it stays spent');
  assert.equal(bank.usageHistory(q.id)[0].quiz_name, 'Week 9');
  assert.deepEqual(bank.draw({ count: 5 }).map((x) => x.id), []);
});

test('refuses to delete a question that has been asked', () => {
  reset();
  const q = bank.createQuestion(sample('Asked already'));
  const { quiz } = quizzes.createQuiz({ name: 'W', questions: [{ ...q, bankId: q.id }], addToBank: false });
  quizzes.releaseNext(quiz);
  assert.throws(() => bank.deleteQuestion(q.id), /Retire it instead/);
});

test('deletes a question that has never been asked', () => {
  reset();
  const q = bank.createQuestion(sample('Never asked'));
  assert.equal(bank.deleteQuestion(q.id), true);
  assert.equal(bank.getQuestion(q.id), null);
});

test('reports where a repeated question was used before', () => {
  reset();
  const q = bank.createQuestion(sample('Repeated question'));
  const { quiz } = quizzes.createQuiz({ name: 'Week 4', questions: [{ ...q, bankId: q.id }], addToBank: false });
  quizzes.releaseNext(quiz);

  const [match] = bank.checkReuse([{ prompt: 'repeated  QUESTION', options: [{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }] }]);
  assert.equal(match.known, true);
  assert.equal(match.used, true);
  assert.equal(match.history[0].quiz_name, 'Week 4');
});

test('importing the same Markdown twice adds nothing the second time', () => {
  reset();
  const markdown = `## Question 1
**Time:** 20

First imported question

- [x] a
- [ ] b
- [ ] c
- [ ] d

## Question 2
**Time:** 20

Second imported question

- [x] a
- [ ] b
- [ ] c
- [ ] d
`;
  const first = bank.importMarkdown(markdown);
  assert.equal(first.added.length, 2);
  assert.equal(first.duplicates.length, 0);

  const second = bank.importMarkdown(markdown);
  assert.equal(second.added.length, 0);
  assert.equal(second.duplicates.length, 2);
});

test('import refuses Markdown that does not validate', () => {
  reset();
  assert.throws(
    () => bank.importMarkdown('## Question 1\n**Time:** 2\n\nQ\n\n- [x] a\n'),
    (error) => error.status === 400 && Array.isArray(error.details.errors),
  );
});

test('counts and stats agree with the filters', () => {
  reset();
  bank.createQuestion(sample('One', { topic: 'A' }));
  bank.createQuestion(sample('Two', { topic: 'B' }));
  bank.createQuestion(sample('Three', { topic: 'B', difficulty: 'hard' }));

  assert.equal(bank.countQuestions({}), 3);
  assert.equal(bank.countQuestions({ topic: 'B' }), 2);
  assert.equal(bank.countQuestions({ difficulty: 'hard' }), 1);
  assert.equal(bank.countQuestions({ search: 'Three' }), 1);
  assert.equal(bank.stats().available, 3);
});

test('the bank exports back to importable Markdown', () => {
  reset();
  bank.createQuestion(sample('Exported question'));
  const markdown = bank.exportMarkdown();
  const parsed = require('../server/markdown').parseQuiz(markdown);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
  assert.equal(parsed.questions[0].prompt, 'Exported question');
});

test('updates one bank question from Markdown with topic and difficulty', () => {
  reset();
  const original = bank.createQuestion(sample('Before editing'));
  const updated = bank.updateQuestionMarkdown(original.id, `## Question 1
**Time:** 45
**Topic:** Neural retrieval
**Difficulty:** hard

After editing

- [ ] first
- [x] second
- [ ] third
- [ ] fourth`);

  assert.equal(updated.prompt, 'After editing');
  assert.equal(updated.timeLimit, 45);
  assert.equal(updated.topic, 'Neural retrieval');
  assert.equal(updated.difficulty, 'hard');
  assert.equal(updated.answerIndex, 1);
});

test('refuses invalid Markdown when updating a bank question', () => {
  reset();
  const original = bank.createQuestion(sample('Keep me'));
  assert.throws(
    () => bank.updateQuestionMarkdown(original.id, '## Question 1\n**Time:** 2\n\nBroken\n\n- [x] only'),
    (error) => error.status === 400 && Array.isArray(error.details.errors),
  );
  assert.equal(bank.getQuestion(original.id).prompt, 'Keep me');
});
