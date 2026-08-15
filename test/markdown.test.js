'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const md = require('../server/markdown');

const VALID = `# Week 3 Quiz

## Question 1
**Time:** 20
**Image:** https://example.com/a.jpg
**Image alt:** A ranked list
**Reveal:** slow
**Show ranking:** no
**Topic:** Retrieval
**Difficulty:** hard

What is the best answer?

- [ ] First option
- [x] Correct option
- [ ] Third option
- [ ] Fourth option
`;

test('parses a complete quiz', () => {
  const result = md.parseQuiz(VALID);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.title, 'Week 3 Quiz');
  assert.equal(result.questions.length, 1);

  const q = result.questions[0];
  assert.equal(q.timeLimit, 20);
  assert.equal(q.imageUrl, 'https://example.com/a.jpg');
  assert.equal(q.imageAlt, 'A ranked list');
  assert.equal(q.reveal, 'slow');
  assert.equal(q.showRanking, false);
  assert.equal(q.topic, 'Retrieval');
  assert.equal(q.difficulty, 'hard');
  assert.equal(q.answerIndex, 1);
  assert.equal(q.options.length, 4);
});

test('round-trips through the serializer without loss', () => {
  const first = md.parseQuiz(VALID);
  const second = md.parseQuiz(md.serializeQuiz(first.title, first.questions));
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  assert.deepEqual(second.questions[0].options, first.questions[0].options);
  assert.equal(second.questions[0].answerIndex, first.questions[0].answerIndex);
  assert.equal(second.questions[0].showRanking, false);
  assert.equal(second.questions[0].reveal, 'slow');
});

test('defaults reveal to show and ranking to on', () => {
  const result = md.parseQuiz(`# T

## Question 1
**Time:** 15

Q?

- [x] a
- [ ] b
- [ ] c
- [ ] d
`);
  assert.equal(result.ok, true);
  assert.equal(result.questions[0].reveal, 'show');
  assert.equal(result.questions[0].showRanking, true);
});

test('requires a title unless told otherwise', () => {
  const withTitle = md.parseQuiz('## Question 1\n**Time:** 15\n\nQ?\n\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d');
  assert.equal(withTitle.ok, false);
  assert.ok(withTitle.errors.some((e) => /Missing quiz title/.test(e.message)));

  const blocks = md.parseQuestionBlocks('## Question 1\n**Time:** 15\n\nQ?\n\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d');
  assert.equal(blocks.ok, true, JSON.stringify(blocks.errors));
});

test('rejects a time outside 10-600 seconds', () => {
  for (const seconds of [5, 601]) {
    const result = md.parseQuiz(`# T\n\n## Question 1\n**Time:** ${seconds}\n\nQ?\n\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d`);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => /Time must be between/.test(e.message)), `${seconds}s should be refused`);
  }
});

test('requires exactly one correct option', () => {
  const none = md.parseQuiz('# T\n\n## Question 1\n**Time:** 15\n\nQ?\n\n- [ ] a\n- [ ] b\n- [ ] c\n- [ ] d');
  assert.ok(none.errors.some((e) => /no correct answer/.test(e.message)));

  const two = md.parseQuiz('# T\n\n## Question 1\n**Time:** 15\n\nQ?\n\n- [x] a\n- [x] b\n- [ ] c\n- [ ] d');
  assert.ok(two.errors.some((e) => /marks 2 options as correct/.test(e.message)));
});

test('requires between four and six options', () => {
  const three = md.parseQuiz('# T\n\n## Question 1\n**Time:** 15\n\nQ?\n\n- [x] a\n- [ ] b\n- [ ] c');
  assert.ok(three.errors.some((e) => /Provide between 4 and 6/.test(e.message)));

  const seven = md.parseQuiz(`# T\n\n## Question 1\n**Time:** 15\n\nQ?\n\n${
    ['- [x] a', '- [ ] b', '- [ ] c', '- [ ] d', '- [ ] e', '- [ ] f', '- [ ] g'].join('\n')}`);
  assert.ok(seven.errors.some((e) => /Provide between 4 and 6/.test(e.message)));
});

test('refuses an image URL that could execute', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:msgbox']) {
    const result = md.parseQuiz(`# T\n\n## Question 1\n**Time:** 15\n**Image:** ${bad}\n**Image alt:** x\n\nQ?\n\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d`);
    assert.equal(result.ok, false, `${bad} should be refused`);
  }
});

test('accepts http, https and root-relative images', () => {
  for (const good of ['https://x.test/a.png', 'http://x.test/a.png', '/assets/a.png']) {
    const result = md.parseQuiz(`# T\n\n## Question 1\n**Time:** 15\n**Image:** ${good}\n**Image alt:** x\n\nQ?\n\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d`);
    assert.equal(result.ok, true, `${good} should be accepted: ${JSON.stringify(result.errors)}`);
  }
});

test('requires alt text whenever an image is used', () => {
  const result = md.parseQuiz('# T\n\n## Question 1\n**Time:** 15\n**Image:** https://x.test/a.png\n\nQ?\n\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d');
  assert.ok(result.errors.some((e) => /Alt text is required/.test(e.message)));
});

test('reports the source line for each problem', () => {
  const result = md.parseQuiz(`# T

## Question 1
**Time:** 3

Q?

- [x] a
- [ ] b
- [ ] c
- [ ] d
`);
  const timeError = result.errors.find((e) => /Time must be between/.test(e.message));
  assert.equal(timeError.line, 4, 'the Time line is line 4');
});

test('flags questions numbered out of order', () => {
  const result = md.parseQuiz(`# T

## Question 1
**Time:** 15

A?

- [x] a
- [ ] b
- [ ] c
- [ ] d

## Question 5
**Time:** 15

B?

- [x] a
- [ ] b
- [ ] c
- [ ] d
`);
  assert.ok(result.errors.some((e) => /numbered 5 but is in position 2/.test(e.message)));
});

test('appending continues the numbering from a start position', () => {
  const result = md.parseQuestionBlocks('## Question 4\n**Time:** 15\n\nQ?\n\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d', 4);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.questions[0].position, 4);
});

test('rejects duplicated options within one question', () => {
  const result = md.parseQuiz('# T\n\n## Question 1\n**Time:** 15\n\nQ?\n\n- [x] same\n- [ ] same\n- [ ] c\n- [ ] d');
  assert.ok(result.errors.some((e) => /repeats the option/.test(e.message)));
});

test('collects several problems rather than stopping at the first', () => {
  const result = md.parseQuiz('# T\n\n## Question 1\n**Time:** 2\n\nQ?\n\n- [x] a\n- [x] b');
  assert.ok(result.errors.length >= 3, `expected several errors, got ${result.errors.length}`);
});
