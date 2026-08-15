'use strict';

require('./helper');

const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../server/db');
const auth = require('../server/auth');
const { app } = require('../server/index');

db.migrate();
auth.ensureAdminAccount();

let base;
let server;
let cookie = '';
let csrf = '';

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  db.close();
});

async function call(method, path, body, headers = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const type = response.headers.get('content-type') || '';
  const data = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, data, headers: response.headers };
}

const QUIZ_MD = `# API Test Quiz

## Question 1
**Time:** 10

Which structure maps a term to its documents?

- [x] Inverted index
- [ ] Forward index
- [ ] Trie
- [ ] Bloom filter

## Question 2
**Time:** 10
**Show ranking:** no

What does stemming do?

- [ ] Removes duplicates
- [x] Reduces words to a root form
- [ ] Sorts postings
- [ ] Ranks documents
`;

test('serves a health ping without a session', async () => {
  const result = await call('GET', '/api/ping');
  assert.equal(result.status, 200);
  assert.equal(result.data.service, 'tempoquiz');
});

test('sets hardening headers on every response', async () => {
  const { headers } = await call('GET', '/api/ping');
  assert.match(headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('x-powered-by'), null);
});

test('refuses the wrong password and accepts the right one', async () => {
  const bad = await call('POST', '/api/admin/login', { username: 'tester', password: 'nope' });
  assert.equal(bad.status, 401);
  assert.match(bad.data.error, /Incorrect username or password/);

  const wrongUser = await call('POST', '/api/admin/login', { username: 'nobody', password: 'testpassword1' });
  assert.equal(wrongUser.status, 401);
  assert.equal(wrongUser.data.error, bad.data.error, 'the same message for a bad user and a bad password');

  const good = await call('POST', '/api/admin/login', { username: 'tester', password: 'testpassword1' });
  assert.equal(good.status, 200);
  csrf = good.data.csrfToken;
  assert.ok(csrf);
});

test('protects the bank behind the session', async () => {
  const saved = cookie;
  cookie = '';
  const result = await call('GET', '/api/bank/questions');
  assert.equal(result.status, 401);
  cookie = saved;

  const allowed = await call('GET', '/api/bank/questions');
  assert.equal(allowed.status, 200);
});

test('refuses a state change without a valid CSRF token', async () => {
  const saved = csrf;
  csrf = 'wrong-token';
  const result = await call('POST', '/api/bank/questions', { prompt: 'x' });
  assert.equal(result.status, 403);
  assert.match(result.data.error, /CSRF/);
  csrf = saved;
});

test('refuses a cross-origin state change', async () => {
  const result = await call('POST', '/api/bank/import', { markdown: '# x' }, { origin: 'https://evil.test' });
  assert.equal(result.status, 403);
  assert.match(result.data.error, /Cross-origin/);
});

test('validates Markdown without saving it', async () => {
  const good = await call('POST', '/api/quizzes/validate', { markdown: QUIZ_MD });
  assert.equal(good.data.ok, true);
  assert.equal(good.data.questionCount, 2);
  assert.equal(good.data.totalSeconds, 20);

  const bad = await call('POST', '/api/quizzes/validate', { markdown: '# T\n\n## Question 1\n**Time:** 2\n\nQ\n\n- [x] a\n' });
  assert.equal(bad.data.ok, false);
  assert.ok(bad.data.errors.length >= 2);
  assert.ok(bad.data.errors.every((e) => typeof e.line === 'number'));

  const quizzes = await call('GET', '/api/admin/quizzes');
  assert.equal(quizzes.data.quizzes.length, 0, 'validation must not create anything');
});

let code;
let hostToken;

test('creates a quiz and returns the host token exactly once', async () => {
  const result = await call('POST', '/api/quizzes', { markdown: QUIZ_MD });
  assert.equal(result.status, 201);
  assert.match(result.data.code, /^[A-Z0-9]{6}$/);
  assert.ok(result.data.hostToken);
  code = result.data.code;
  hostToken = result.data.hostToken;

  const listed = await call('GET', '/api/admin/quizzes');
  const found = listed.data.quizzes.find((q) => q.code === code);
  assert.equal(found.questionCount, 2);
  assert.equal(found.status, 'lobby');
  assert.equal(found.displayStatus, 'prepared', 'a new quiz is prepared, not yet open');
  assert.equal(found.open, false);
  assert.ok(found.archivePath, 'a JSON record is written on creation');
});

// A quiz is written and arranged in advance — often the day before — so the
// room must stay shut until the instructor opens it.
test('a prepared quiz cannot be joined until the room is opened', async () => {
  const lobby = await call('GET', `/api/play/${code}`);
  assert.equal(lobby.status, 200);
  assert.equal(lobby.data.open, false);

  const early = await call('POST', `/api/play/${code}/join`, { nickname: 'Early', studentId: '111A' });
  assert.equal(early.status, 409, JSON.stringify(early.data));
  assert.match(early.data.error, /not open yet/i);

  const state = await call('GET', `/api/quizzes/${code}/host`, null, { 'x-host-token': hostToken });
  assert.equal(state.data.quiz.open, false);
  assert.equal(state.data.quiz.openedAt, null);
});

test('prepared quizzes can be listed on their own', async () => {
  const prepared = await call('GET', '/api/admin/quizzes?status=prepared');
  assert.ok(prepared.data.quizzes.some((q) => q.code === code));

  const openLobbies = await call('GET', '/api/admin/quizzes?status=lobby');
  assert.equal(openLobbies.data.quizzes.some((q) => q.code === code), false,
    'a prepared quiz is not counted as an open lobby');
});

test('opens the room, and opening twice is harmless', async () => {
  const opened = await call('POST', `/api/quizzes/${code}/open`, { hostToken });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  assert.equal(opened.data.open, true);
  assert.ok(opened.data.openedAt);

  const again = await call('POST', `/api/quizzes/${code}/open`, { hostToken });
  assert.equal(again.status, 200);
  assert.equal(again.data.openedAt, opened.data.openedAt, 'the original opening time is kept');

  const lobby = await call('GET', `/api/play/${code}`);
  assert.equal(lobby.data.open, true);

  const listed = await call('GET', '/api/admin/quizzes');
  const found = listed.data.quizzes.find((q) => q.code === code);
  assert.equal(found.displayStatus, 'lobby', 'an opened room is a lobby, not prepared');
});

test('a room can be shut again before the quiz starts, but not after', async () => {
  const made = await call('POST', '/api/quizzes', { markdown: QUIZ_MD.replace('# ', '# Shut ') });
  const shut = made.data.code;
  const token = made.data.hostToken;

  await call('POST', `/api/quizzes/${shut}/open`, { hostToken: token });
  const joined = await call('POST', `/api/play/${shut}/join`, { nickname: 'Keen', studentId: '222B' });
  assert.equal(joined.status, 201);

  const closed = await call('POST', `/api/quizzes/${shut}/close-room`, { hostToken: token });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  const blocked = await call('POST', `/api/play/${shut}/join`, { nickname: 'Later', studentId: '333C' });
  assert.equal(blocked.status, 409, 'the room is shut to new students again');

  // Once questions are being released the room must stay open.
  await call('POST', `/api/quizzes/${shut}/release`, { hostToken: token });
  const refused = await call('POST', `/api/quizzes/${shut}/close-room`, { hostToken: token });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /already started/i);
});

// Nobody should end up in front of a class with a room the students cannot
// join, so releasing a question opens the room if it is somehow still shut.
test('releasing a question opens an unopened room', async () => {
  const made = await call('POST', '/api/quizzes', { markdown: QUIZ_MD.replace('# ', '# Auto ') });
  const auto = made.data.code;
  const before = await call('GET', `/api/play/${auto}`);
  assert.equal(before.data.open, false);

  const released = await call('POST', `/api/quizzes/${auto}/release`, { hostToken: made.data.hostToken });
  assert.equal(released.status, 200, JSON.stringify(released.data));

  const after = await call('GET', `/api/play/${auto}`);
  assert.equal(after.data.open, true, 'the room opened itself when the quiz started');

  const joined = await call('POST', `/api/play/${auto}/join`, { nickname: 'Late', studentId: '777Z' });
  assert.equal(joined.status, 201, 'students can join a quiz already under way');
});

test('serves a QR code for the join URL', async () => {
  const result = await call('GET', `/api/quizzes/${code}/qr.svg`);
  assert.equal(result.status, 200);
  assert.match(result.data, /^<\?xml|^<svg/);
});

const players = {};

test('students join with a nickname and student-number suffix', async () => {
  for (const [nick, suffix] of [['Ana', '123E'], ['Ben', '456A']]) {
    const result = await call('POST', `/api/play/${code}/join`, { nickname: nick, studentId: suffix });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    players[nick] = result.data.token;
  }
});

test('refuses a duplicate nickname and a malformed suffix', async () => {
  const dupe = await call('POST', `/api/play/${code}/join`, { nickname: 'Ana', studentId: '999Z' });
  assert.equal(dupe.status, 409);

  for (const suffix of ['12E', 'ABCDE', '12-4', '']) {
    const bad = await call('POST', `/api/play/${code}/join`, { nickname: `N${suffix}x`, studentId: suffix });
    assert.equal(bad.status, 400, `suffix "${suffix}" should be refused`);
  }
});

test('accepts a student ID suffix of letters as well as digits', async () => {
  const result = await call('POST', `/api/play/${code}/join`, { nickname: 'Kai', studentId: 'ab7z' });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  players.Kai = result.data.token;
});

test('hides the answer until the question closes', async () => {
  await call('POST', `/api/quizzes/${code}/release`, {});

  const ready = await call('GET', `/api/play/${code}/state`, null, { 'x-player-token': players.Ana });
  assert.equal(ready.data.phase, 'ready');
  assert.equal(ready.data.current.answerIndex, undefined, 'no answer during the ready screen');

  const early = await call('POST', `/api/play/${code}/answer`,
    { questionId: ready.data.current.id, choiceIndex: 0 }, { 'x-player-token': players.Ana });
  assert.equal(early.status, 409, 'answers before the timer starts are refused');

  await new Promise((r) => setTimeout(r, 2200));
  const open = await call('GET', `/api/play/${code}/state`, null, { 'x-player-token': players.Ana });
  assert.equal(open.data.phase, 'open');
  assert.equal(open.data.current.answerIndex, undefined, 'no answer while the question is open');
});

test('withholds the running tally from the host while the question is open', async () => {
  const host = await call('GET', `/api/quizzes/${code}/host`);
  assert.equal(host.data.phase, 'open');
  assert.equal(host.data.current.tally, undefined,
    'a projected tally would pull undecided students towards the majority');
  assert.equal(host.data.current.answerIndex, undefined);
  assert.equal(host.data.standingsVisible, false);
  // A bare count is safe and the instructor needs it.
  assert.equal(typeof host.data.answered, 'number');
});

test('accepts one answer per student and scores it', async () => {
  const state = await call('GET', `/api/play/${code}/state`, null, { 'x-player-token': players.Ana });
  const questionId = state.data.current.id;

  const first = await call('POST', `/api/play/${code}/answer`,
    { questionId, choiceIndex: 0 }, { 'x-player-token': players.Ana });
  assert.equal(first.status, 200);
  assert.equal(first.data.correct, undefined, 'correctness is withheld until the question closes');

  const second = await call('POST', `/api/play/${code}/answer`,
    { questionId, choiceIndex: 1 }, { 'x-player-token': players.Ana });
  assert.equal(second.status, 409);

  await call('POST', `/api/play/${code}/answer`,
    { questionId, choiceIndex: 1 }, { 'x-player-token': players.Ben });

  const fresh = await call('POST', `/api/play/${code}/join`, { nickname: 'Cleo', studentId: '789Z' });
  for (const choiceIndex of [99, -1, 'x', null]) {
    const badIndex = await call('POST', `/api/play/${code}/answer`,
      { questionId, choiceIndex }, { 'x-player-token': fresh.data.token });
    assert.equal(badIndex.status, 400, `choiceIndex ${JSON.stringify(choiceIndex)} is a bad request`);
  }
});

test('reveals the answer and the standings once closed', async () => {
  await call('POST', `/api/quizzes/${code}/close`, {});
  const state = await call('GET', `/api/play/${code}/state`, null, { 'x-player-token': players.Ana });

  assert.equal(state.data.phase, 'closed');
  assert.equal(state.data.current.answerIndex, 0);
  assert.equal(state.data.myAnswer.correct, true);
  assert.ok(state.data.myAnswer.points >= 500);
  assert.equal(state.data.showStandings, true);
  assert.equal(state.data.me.rank, 1);
});

test('releases the tally and standings to the host once closed', async () => {
  const host = await call('GET', `/api/quizzes/${code}/host`);
  assert.equal(host.data.phase, 'closed');
  assert.ok(Array.isArray(host.data.current.tally));
  assert.equal(host.data.current.answerIndex, 0);
  assert.equal(host.data.standingsVisible, true);
});

test('never sends Student IDs to a student screen', async () => {
  const state = await call('GET', `/api/play/${code}/state`, null, { 'x-player-token': players.Ana });
  const serialised = JSON.stringify(state.data);
  assert.equal(serialised.includes('123E'), false);
  assert.equal(serialised.includes('456A'), false);
  assert.equal(serialised.includes('studentId'), false);
});

test('honours "Show ranking: no" on the second question', async () => {
  await call('POST', `/api/quizzes/${code}/release`, {});
  await new Promise((r) => setTimeout(r, 2200));
  await call('POST', `/api/quizzes/${code}/close`, {});

  const state = await call('GET', `/api/play/${code}/state`, null, { 'x-player-token': players.Ana });
  assert.equal(state.data.showStandings, false);
  assert.equal(state.data.standings, null);
});

test('the host gets a live tally but never a Student ID', async () => {
  const state = await call('GET', `/api/quizzes/${code}/host`);
  assert.equal(state.data.participants.length, 4);
  assert.ok(Array.isArray(state.data.current.tally));
  assert.match(state.data.joinUrl, /\/join\//);

  // The host screen goes on a projector, so identifiers must not be in the
  // payload at all, not merely hidden in the page.
  const serialised = JSON.stringify(state.data);
  assert.equal(serialised.includes('123E'), false);
  assert.equal(serialised.includes('456A'), false);
  assert.equal(serialised.includes('studentId'), false);
  assert.ok(state.data.participants.every((p) => p.nickname));
});

test('the host is not sent the text of an unreleased question', async () => {
  const secret = 'Which Bhutanese city is the capital';
  await call('POST', `/api/quizzes/${code}/append`, {
    expectedQuestionCount: 2,
    markdown: `## Question 3\n**Time:** 10\n\n${secret}?\n\n- [x] Thimphu\n- [ ] Paro\n- [ ] Punakha\n- [ ] Wangdue`,
  });

  const state = await call('GET', `/api/quizzes/${code}/host`);
  assert.equal(JSON.stringify(state.data).includes(secret), false,
    'an unreleased question must not reach the projector');

  const hidden = state.data.outline.find((q) => q.position === 3);
  assert.equal(hidden.prompt, null);
  assert.equal(hidden.released, false);
  // Released questions are fine: the class has already been shown them.
  assert.ok(state.data.outline.find((q) => q.position === 1).prompt);
});

test('appending guards against a stale question count', async () => {
  const stale = await call('POST', `/api/quizzes/${code}/append`, {
    expectedQuestionCount: 99,
    markdown: '## Question 3\n**Time:** 10\n\nQ?\n\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d',
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.details.actualQuestionCount, 3);

  const good = await call('POST', `/api/quizzes/${code}/append`, {
    expectedQuestionCount: 3,
    markdown: '## Question 4\n**Time:** 10\n\nWhat is a corpus?\n\n- [x] A document collection\n- [ ] A query\n- [ ] An index\n- [ ] A token',
  });
  assert.equal(good.status, 200);
  assert.equal(good.data.questionCount, 4);
});

test('a fresh tab can recover its CSRF token from the session check', async () => {
  const saved = csrf;
  csrf = '';
  const session = await call('GET', '/api/admin/session');
  assert.equal(session.data.authenticated, true);
  assert.ok(session.data.csrfToken, 'the session check hands the token back');

  csrf = session.data.csrfToken;
  const acted = await call('POST', '/api/admin/backup');
  assert.equal(acted.status, 200, 'the recovered token is accepted');
  csrf = saved;
});

test('quiz control refuses a session request with no CSRF token', async () => {
  const saved = csrf;
  csrf = '';
  const result = await call('POST', `/api/quizzes/${code}/release`, {});
  assert.equal(result.status, 403);
  assert.match(result.data.error, /CSRF/);
  csrf = saved;
});

test('the host token works on its own, and a wrong one does not', async () => {
  const saved = cookie;
  cookie = '';

  const none = await fetch(`${base}/api/quizzes/${code}/host`);
  assert.equal(none.status, 403);

  const wrong = await fetch(`${base}/api/quizzes/${code}/host`, { headers: { 'x-host-token': 'nope' } });
  assert.equal(wrong.status, 403);

  const right = await fetch(`${base}/api/quizzes/${code}/host`, { headers: { 'x-host-token': hostToken } });
  assert.equal(right.status, 200);

  cookie = saved;
});

test('finishes the quiz and exports every format', async () => {
  const finished = await call('POST', `/api/quizzes/${code}/finish`, {});
  assert.equal(finished.data.status, 'finished');

  const json = await call('POST', `/api/quizzes/${code}/export`, { format: 'json' });
  assert.equal(json.status, 200);
  const record = typeof json.data === 'string' ? JSON.parse(json.data) : json.data;
  assert.equal(record.format, 'tempoquiz.record.v1');
  assert.equal(record.questions.length, 4);
  assert.equal(record.participants.length, 4);
  assert.ok(record.participants.some((p) => p.studentId === '123E'),
    'identifiers are withheld from screens but kept in the record');
  const cleo = record.participants.find((p) => p.nickname === 'Cleo');
  assert.equal(cleo.answered, 0, 'a student who joined but never answered is still recorded');
  assert.equal(cleo.score, 0);

  const csv = await call('POST', `/api/quizzes/${code}/export`, { format: 'csv' });
  assert.match(csv.data, /rank,nickname,student_id/);
  assert.match(csv.data, /Ana/);

  assert.match(csv.data, /123E/);

  const markdown = await call('POST', `/api/quizzes/${code}/export`, { format: 'markdown' });
  assert.match(markdown.data, /^# API Test Quiz/);
  assert.match(markdown.data, /## Results/);

  const bad = await call('POST', `/api/quizzes/${code}/export`, { format: 'pdf' });
  assert.equal(bad.status, 400);
});

test('a finished quiz refuses new questions', async () => {
  const result = await call('POST', `/api/quizzes/${code}/append`, {
    markdown: '## Question 5\n**Time:** 10\n\nQ?\n\n- [x] a\n- [ ] b\n- [ ] c\n- [ ] d',
  });
  assert.equal(result.status, 409);
});

test('warns that the quiz questions are now spent', async () => {
  const result = await call('POST', '/api/bank/check-reuse', { markdown: QUIZ_MD });
  assert.equal(result.data.repeatedCount, 2);
  assert.ok(result.data.matches.every((m) => m.known));
});

test('refuses to rebuild a quiz from a used question unless forced', async () => {
  const used = await call('GET', '/api/bank/questions?status=used');
  const id = used.data.questions[0].id;

  const blocked = await call('POST', '/api/quizzes', { name: 'Repeat', questionIds: [id] });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /already been used/);

  const forced = await call('POST', '/api/quizzes', { name: 'Deliberate repeat', questionIds: [id], allowUsed: true });
  assert.equal(forced.status, 201);
});

test('reports database integrity in the health endpoint', async () => {
  const result = await call('GET', '/api/admin/health');
  assert.equal(result.data.integrity, 'ok');
  assert.ok(result.data.counts.answers >= 2);
  assert.ok(result.data.archives >= 1);
});

test('signing out invalidates the session', async () => {
  await call('POST', '/api/admin/logout');
  cookie = '';
  const result = await call('GET', '/api/admin/health');
  assert.equal(result.status, 401);
});

test('returns 404 as JSON for unknown API routes', async () => {
  const result = await call('GET', '/api/nope');
  assert.equal(result.status, 404);
  assert.equal(result.data.ok, false);
});
