'use strict';

const config = require('./config');
const { query, transaction } = require('./db');
const bank = require('./bank');
const md = require('./markdown');
const archive = require('./archive');
const { scoreAnswer, rankParticipants } = require('./scoring');
const {
  nowIso,
  todayStamp,
  randomCode,
  randomToken,
  sha256,
  safeEqual,
  slugify,
  csvRows,
  badRequest,
  notFound,
  forbidden,
  conflict,
} = require('./util');

// --- lookup -----------------------------------------------------------------

function getQuizByCode(code) {
  const clean = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,10}$/.test(clean)) return null;
  return query.get('SELECT * FROM quiz WHERE code = ?', clean);
}

function getQuizById(id) {
  return query.get('SELECT * FROM quiz WHERE id = ?', id);
}

function requireQuiz(code) {
  const quiz = getQuizByCode(code);
  if (!quiz) throw notFound('No quiz with that room code. Check the code and try again.');
  return quiz;
}

/** Verifies the instructor's host token against the stored hash. */
function requireHost(quiz, hostToken) {
  if (!hostToken || !safeEqual(sha256(hostToken), quiz.host_token_hash)) {
    throw forbidden('That host token is not valid for this quiz.');
  }
  return quiz;
}

function questionsFor(quizId) {
  return query.all('SELECT * FROM quiz_question WHERE quiz_id = ? ORDER BY position', quizId);
}

function parseOptions(row) {
  try {
    return JSON.parse(row.options_json);
  } catch {
    return [];
  }
}

// --- creation ---------------------------------------------------------------

function allocateCode() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const code = randomCode(6);
    if (!query.get('SELECT 1 AS x FROM quiz WHERE code = ?', code)) return code;
  }
  throw new Error('Could not allocate a unique room code');
}

/**
 * Question sources disagree on how they spell a boolean: the parser yields
 * true/false, the bank normaliser yields 1/0, and the API may send a string.
 * Everything that is not recognisably "off" defaults to on.
 */
function toFlag(value, fallback = 1) {
  if (value === undefined || value === null) return fallback;
  if (value === false || value === 0 || value === '0' || value === 'no' || value === 'false') return 0;
  return 1;
}

function insertQuestion(quizId, question, position) {
  query.run(
    `INSERT INTO quiz_question
       (quiz_id, position, bank_question_id, prompt, image_url, image_alt, time_limit,
        reveal, show_ranking, options_json, answer_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    quizId,
    position,
    question.bankId ?? question.bank_question_id ?? null,
    question.prompt,
    question.imageUrl ?? null,
    question.imageAlt ?? null,
    question.timeLimit,
    question.reveal ?? 'show',
    toFlag(question.showRanking ?? question.show_ranking),
    JSON.stringify(question.options),
    question.answerIndex,
  );
}

/**
 * Creates a quiz from already-validated questions and returns the quiz row
 * along with the one-time host token (only ever returned here; the database
 * keeps a hash).
 */
function createQuiz({ name, questions, addToBank = true }) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName) throw badRequest('The quiz needs a title.');
  if (cleanName.length > 150) throw badRequest('The quiz title must be 150 characters or fewer.');
  if (!questions.length) throw badRequest('A quiz needs at least one question.');

  const hostToken = randomToken(32);
  const code = allocateCode();
  const created = new Date();

  const quizId = transaction(() => {
    const result = query.run(
      `INSERT INTO quiz (code, name, slug, status, host_token_hash, current_index, created_at, created_date)
       VALUES (?, ?, ?, 'lobby', ?, -1, ?, ?)`,
      code,
      cleanName,
      slugify(cleanName),
      sha256(hostToken),
      created.toISOString(),
      todayStamp(created),
    );
    const id = Number(result.lastInsertRowid);

    questions.forEach((question, index) => {
      let bankId = question.bankId ?? null;
      if (!bankId && addToBank) {
        // Growing the bank from pasted Markdown is what lets the no-repeat
        // check work on the next quiz. An existing entry is reused, not
        // duplicated, so its usage history stays intact.
        try {
          bankId = bank.createQuestion({ ...question, topic: question.topic || cleanName }).id;
        } catch (error) {
          if (error.status === 409 && error.details) bankId = error.details.existingId;
          else if (error.status !== 409) throw error;
        }
      }
      insertQuestion(id, { ...question, bankId }, index + 1);
    });
    return id;
  });

  const quiz = getQuizById(quizId);
  writeArchiveFor(quiz);
  return { quiz: getQuizById(quizId), hostToken };
}

/** Builds a quiz from Markdown, refusing anything the parser flags. */
function createFromMarkdown({ markdown, name, addToBank = true }) {
  const parsed = md.parseQuiz(markdown);
  if (!parsed.ok) {
    throw badRequest('The quiz Markdown has problems that must be fixed first.', { errors: parsed.errors });
  }
  const questions = parsed.questions.map((q) => bank.normaliseQuestion(q, { context: `Question ${q.position}` }));
  return createQuiz({ name: name || parsed.title, questions, addToBank });
}

/** Builds a quiz by picking existing bank questions, in the given order. */
function createFromBank({ name, questionIds, allowUsed = false }) {
  const ids = Array.isArray(questionIds) ? questionIds.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) throw badRequest('Select at least one question from the bank.');
  if (new Set(ids).size !== ids.length) throw badRequest('The same question is selected more than once.');

  const questions = ids.map((id) => {
    const entry = bank.getQuestion(id);
    if (!entry) throw badRequest(`Question ${id} is no longer in the bank.`);
    if (entry.retired) throw badRequest(`"${entry.prompt.slice(0, 60)}…" is retired and cannot be used.`);
    if (!allowUsed && entry.useCount > 0) {
      throw conflict(
        `"${entry.prompt.slice(0, 60)}…" has already been used in a previous quiz.`,
        { questionId: id, history: bank.usageHistory(id) },
      );
    }
    return { ...entry, bankId: entry.id };
  });

  return createQuiz({ name, questions, addToBank: false });
}

/**
 * Appends complete question blocks to a lobby or in-flight quiz.
 * `expectedQuestionCount` guards against two editors appending to different
 * versions of the same quiz.
 */
function appendQuestions(quiz, { markdown, expectedQuestionCount, addToBank = true }) {
  if (quiz.status === 'finished') throw conflict('This quiz has finished. Questions can no longer be added.');

  const existing = questionsFor(quiz.id);
  if (
    expectedQuestionCount !== undefined &&
    expectedQuestionCount !== null &&
    Number(expectedQuestionCount) !== existing.length
  ) {
    throw conflict(
      `This quiz now has ${existing.length} questions, not ${expectedQuestionCount}. Reload the quiz and append again.`,
      { actualQuestionCount: existing.length },
    );
  }

  const parsed = md.parseQuestionBlocks(markdown, existing.length + 1);
  if (!parsed.ok) {
    throw badRequest('The appended Markdown has problems that must be fixed first.', { errors: parsed.errors });
  }
  if (!parsed.questions.length) throw badRequest('No complete question blocks found to append.');
  if (existing.length + parsed.questions.length > md.MAX_QUESTIONS) {
    throw badRequest(`A quiz can hold at most ${md.MAX_QUESTIONS} questions.`);
  }

  const normalised = parsed.questions.map((q) => bank.normaliseQuestion(q, { context: `Question ${q.position}` }));

  transaction(() => {
    normalised.forEach((question, index) => {
      let bankId = null;
      if (addToBank) {
        try {
          bankId = bank.createQuestion({ ...question, topic: question.topic || quiz.name }).id;
        } catch (error) {
          if (error.status === 409 && error.details) bankId = error.details.existingId;
          else if (error.status !== 409) throw error;
        }
      }
      insertQuestion(quiz.id, { ...question, bankId }, existing.length + index + 1);
    });
  });

  const fresh = getQuizById(quiz.id);
  writeArchiveFor(fresh);
  return { added: normalised.length, questionCount: existing.length + normalised.length };
}

// --- lifecycle --------------------------------------------------------------

/**
 * Opens the next question. Students see a synchronised ready screen for
 * READY_MS before the clock starts, so a slow phone is not penalised for
 * rendering late.
 */
/**
 * A quiz is written and arranged first and run later — often on another day —
 * so the room stays shut until the instructor opens it. Until then the code
 * exists but nobody can join, which is what stops a class wandering into
 * tomorrow's lecture tonight.
 */
function isOpen(quiz) {
  return Boolean(quiz.opened_at);
}

/** Opens the room for joining. Idempotent, so a double click is harmless. */
function openRoom(quiz) {
  if (quiz.status === 'finished') throw conflict('This quiz has already finished.');
  if (isOpen(quiz)) return getQuizById(quiz.id);
  query.run('UPDATE quiz SET opened_at = ? WHERE id = ?', nowIso(), quiz.id);
  return getQuizById(quiz.id);
}

/**
 * Shuts the room again — for a room opened too early, or one prepared before
 * rooms could be kept shut. Refused once the quiz has started: the students in
 * it are mid-question, and anyone who reloaded would be locked out.
 */
function closeRoom(quiz) {
  if (quiz.status !== 'lobby') {
    throw conflict('This quiz has already started, so the room cannot be closed again.');
  }
  query.run('UPDATE quiz SET opened_at = NULL WHERE id = ?', quiz.id);
  return getQuizById(quiz.id);
}

function releaseNext(quiz) {
  if (quiz.status === 'finished') throw conflict('This quiz has already finished.');
  const questions = questionsFor(quiz.id);
  const nextIndex = quiz.current_index + 1;
  if (nextIndex >= questions.length) {
    throw conflict('Every question has been released. Finish the quiz to show the final leaderboard.');
  }

  const question = questions[nextIndex];
  const releasedAt = new Date();
  const endsAt = new Date(releasedAt.getTime() + config.READY_MS + question.time_limit * 1000);

  transaction(() => {
    // Close anything still open so a skipped question cannot accept answers.
    query.run(
      `UPDATE quiz_question SET closed_at = ?
        WHERE quiz_id = ? AND released_at IS NOT NULL AND closed_at IS NULL`,
      releasedAt.toISOString(),
      quiz.id,
    );
    query.run(
      'UPDATE quiz_question SET released_at = ?, ends_at = ?, closed_at = NULL WHERE id = ?',
      releasedAt.toISOString(),
      endsAt.toISOString(),
      question.id,
    );
    query.run(
      `UPDATE quiz SET current_index = ?, status = 'running',
              opened_at = COALESCE(opened_at, ?), started_at = COALESCE(started_at, ?)
        WHERE id = ?`,
      nextIndex,
      // Releasing a question means the lecture has started, so an unopened
      // room opens itself rather than leaving the instructor stuck in front
      // of a class with a code nobody can join.
      releasedAt.toISOString(),
      releasedAt.toISOString(),
      quiz.id,
    );
    // The class has now seen this question, so it is permanently spent.
    if (question.bank_question_id) bank.recordUsage(question.bank_question_id, quiz);
  });

  return { index: nextIndex, questionId: question.id, endsAt: endsAt.toISOString() };
}

function closeCurrent(quiz) {
  const question = currentQuestion(quiz);
  if (!question) throw conflict('No question is open.');
  if (question.closed_at) return question;
  query.run('UPDATE quiz_question SET closed_at = ? WHERE id = ?', nowIso(), question.id);
  return query.get('SELECT * FROM quiz_question WHERE id = ?', question.id);
}

function finishQuiz(quiz) {
  const at = nowIso();
  transaction(() => {
    query.run(
      `UPDATE quiz_question SET closed_at = ?
        WHERE quiz_id = ? AND released_at IS NOT NULL AND closed_at IS NULL`,
      at,
      quiz.id,
    );
    query.run("UPDATE quiz SET status = 'finished', finished_at = ? WHERE id = ?", at, quiz.id);
  });
  const fresh = getQuizById(quiz.id);
  writeArchiveFor(fresh);
  return fresh;
}

/** Puts one question on every student screen for post-quiz review. */
function setReview(quiz, position) {
  if (position === null || position === undefined || position === '') {
    query.run('UPDATE quiz SET review_position = NULL WHERE id = ?', quiz.id);
    return null;
  }
  const pos = Number.parseInt(position, 10);
  const question = query.get('SELECT * FROM quiz_question WHERE quiz_id = ? AND position = ?', quiz.id, pos);
  if (!question) throw notFound(`This quiz has no question ${position}.`);
  query.run('UPDATE quiz SET review_position = ? WHERE id = ?', pos, quiz.id);
  return question;
}

function currentQuestion(quiz) {
  if (quiz.current_index < 0) return null;
  return query.get(
    'SELECT * FROM quiz_question WHERE quiz_id = ? AND position = ?',
    quiz.id,
    quiz.current_index + 1,
  );
}

/**
 * Derives the live phase of a question from the clock, so the host and every
 * student agree without needing an explicit "close" call to have landed.
 */
function phaseOf(question, now = Date.now()) {
  if (!question || !question.released_at) return 'pending';
  if (question.closed_at && new Date(question.closed_at).getTime() <= now) return 'closed';
  const released = new Date(question.released_at).getTime();
  const ends = new Date(question.ends_at).getTime();
  if (now < released + config.READY_MS) return 'ready';
  if (now < ends) return 'open';
  return 'closed';
}

// --- participants -----------------------------------------------------------

function joinQuiz(quiz, { nickname, studentId }) {
  if (quiz.status === 'finished') throw conflict('This quiz has already finished.');
  if (!isOpen(quiz)) {
    throw conflict('This room is not open yet. Your instructor will open it when the session starts.');
  }

  const cleanNick = String(nickname ?? '').trim().replace(/\s+/g, ' ');
  if (cleanNick.length < 2 || cleanNick.length > 24) {
    throw badRequest('Your nickname must be between 2 and 24 characters.');
  }
  if (!/^[\p{L}\p{N} ._'-]+$/u.test(cleanNick)) {
    throw badRequest('Your nickname can only use letters, numbers, spaces and . _ - characters.');
  }

  // The last four characters only, never the whole ID: enough to tell two
  // students with the same nickname apart, without collecting an identifier
  // the app has no need to hold. Letters and digits both allowed, since
  // student ID formats differ between institutions.
  const suffix = String(studentId ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(suffix)) {
    throw badRequest('Enter the last 4 characters of your Student ID, for example 123E.');
  }

  const existing = query.get(
    'SELECT * FROM participant WHERE quiz_id = ? AND nickname = ? AND student_id = ?',
    quiz.id,
    cleanNick,
    suffix,
  );

  const token = randomToken(24);
  if (existing) {
    // Same nickname and suffix: treat as the same student rejoining after a
    // refresh or a dropped connection, and issue a fresh token.
    query.run(
      'UPDATE participant SET token_hash = ?, last_seen = ? WHERE id = ?',
      sha256(token),
      nowIso(),
      existing.id,
    );
    return { participant: query.get('SELECT * FROM participant WHERE id = ?', existing.id), token, rejoined: true };
  }

  const nameTaken = query.get(
    'SELECT 1 AS x FROM participant WHERE quiz_id = ? AND nickname = ?',
    quiz.id,
    cleanNick,
  );
  if (nameTaken) throw conflict('Someone in this room is already using that nickname. Pick another one.');

  const count = query.get('SELECT COUNT(*) AS n FROM participant WHERE quiz_id = ?', quiz.id);
  if (Number(count.n) >= config.MAX_PARTICIPANTS) {
    throw conflict('This quiz room is full.');
  }

  const at = nowIso();
  const result = query.run(
    `INSERT INTO participant (quiz_id, nickname, student_id, token_hash, joined_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
    quiz.id, cleanNick, suffix, sha256(token), at, at,
  );
  return {
    participant: query.get('SELECT * FROM participant WHERE id = ?', Number(result.lastInsertRowid)),
    token,
    rejoined: false,
  };
}

function participantFromToken(quiz, token) {
  if (!token) return null;
  const row = query.get(
    'SELECT * FROM participant WHERE quiz_id = ? AND token_hash = ?',
    quiz.id,
    sha256(token),
  );
  if (row) query.run('UPDATE participant SET last_seen = ? WHERE id = ?', nowIso(), row.id);
  return row || null;
}

/**
 * Records one answer. The unique index on (question_id, participant_id) is
 * what actually enforces one answer per student; the check here just produces
 * a friendlier message in the common case.
 */
function submitAnswer(quiz, participant, { questionId, choiceIndex }) {
  const question = query.get(
    'SELECT * FROM quiz_question WHERE id = ? AND quiz_id = ?',
    questionId,
    quiz.id,
  );
  if (!question) throw notFound('That question is not part of this quiz.');
  if (!question.released_at) throw conflict('That question has not been released yet.');

  const now = Date.now();
  const startsAt = new Date(question.released_at).getTime() + config.READY_MS;
  const endsAt = new Date(question.ends_at).getTime();
  const closedAt = question.closed_at ? new Date(question.closed_at).getTime() : null;

  if (now < startsAt) throw conflict('The question has not started yet.');
  // A small grace window absorbs network latency so a phone that submitted in
  // time is not rejected for arriving a few hundred milliseconds late.
  const deadline = Math.min(closedAt ?? Infinity, endsAt) + config.ANSWER_GRACE_MS;
  if (now > deadline) throw conflict("Time is up for that question.");

  const options = parseOptions(question);
  const choice = Number.parseInt(choiceIndex, 10);
  if (!Number.isInteger(choice) || choice < 0 || choice >= options.length) {
    throw badRequest('That answer option does not exist.');
  }

  const existing = query.get(
    'SELECT * FROM answer WHERE question_id = ? AND participant_id = ?',
    question.id,
    participant.id,
  );
  if (existing) throw conflict('You have already answered this question.');

  const msTaken = Math.max(0, now - startsAt);
  const correct = choice === question.answer_index;
  const points = scoreAnswer(correct, msTaken, question.time_limit);

  try {
    transaction(() => {
      query.run(
        `INSERT INTO answer (quiz_id, question_id, participant_id, choice_index, correct, ms_taken, points, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        quiz.id, question.id, participant.id, choice, correct ? 1 : 0, msTaken, points, nowIso(),
      );
      query.run('UPDATE participant SET score = score + ? WHERE id = ?', points, participant.id);
    });
  } catch (error) {
    if (String(error.message || '').includes('UNIQUE')) {
      throw conflict('You have already answered this question.');
    }
    throw error;
  }

  return { accepted: true, points, correct, msTaken };
}

// --- views ------------------------------------------------------------------

function optionTally(questionId) {
  const rows = query.all(
    'SELECT choice_index, COUNT(*) AS n FROM answer WHERE question_id = ? GROUP BY choice_index',
    questionId,
  );
  const tally = new Map(rows.map((row) => [Number(row.choice_index), Number(row.n)]));
  return tally;
}

function publicQuestion(question, { includeAnswer }) {
  const options = parseOptions(question);
  const base = {
    id: question.id,
    position: question.position,
    prompt: question.prompt,
    imageUrl: question.image_url,
    imageAlt: question.image_alt,
    timeLimit: question.time_limit,
    reveal: question.reveal,
    showRanking: Boolean(question.show_ranking),
    options: options.map((option, index) => ({ index, text: option.text })),
    releasedAt: question.released_at,
    endsAt: question.ends_at,
    closedAt: question.closed_at,
    startsAt: question.released_at
      ? new Date(new Date(question.released_at).getTime() + config.READY_MS).toISOString()
      : null,
  };
  if (includeAnswer) {
    base.answerIndex = question.answer_index;
    const tally = optionTally(question.id);
    base.tally = options.map((_, index) => tally.get(index) || 0);
  }
  return base;
}

function leaderboardRows(quizId) {
  const rows = query.all(
    `SELECT p.id, p.nickname, p.student_id, p.score,
            (SELECT COALESCE(SUM(a.ms_taken), 0) FROM answer a WHERE a.participant_id = p.id) AS total_ms,
            (SELECT COUNT(*) FROM answer a WHERE a.participant_id = p.id AND a.correct = 1) AS correct_count,
            (SELECT COUNT(*) FROM answer a WHERE a.participant_id = p.id) AS answered_count
       FROM participant p WHERE p.quiz_id = ?`,
    quizId,
  );
  return rankParticipants(rows.map((row) => ({
    ...row,
    score: Number(row.score),
    total_ms: Number(row.total_ms),
    correct_count: Number(row.correct_count),
    answered_count: Number(row.answered_count),
  })));
}

/** Leaderboard for public screens: nicknames and scores only. */
function publicLeaderboard(quizId, limit = 20) {
  return leaderboardRows(quizId).slice(0, limit).map((row) => ({
    rank: row.rank,
    nickname: row.nickname,
    score: row.score,
    correct: row.correct_count,
  }));
}

/** Everything the host dashboard renders. */
function hostState(quiz) {
  const questions = questionsFor(quiz.id);
  const question = currentQuestion(quiz);
  const phase = phaseOf(question);
  const participants = leaderboardRows(quiz.id);
  const review = quiz.review_position
    ? query.get('SELECT * FROM quiz_question WHERE quiz_id = ? AND position = ?', quiz.id, quiz.review_position)
    : null;

  return {
    quiz: {
      code: quiz.code,
      name: quiz.name,
      status: quiz.status,
      open: isOpen(quiz),
      createdAt: quiz.created_at,
      openedAt: quiz.opened_at,
      startedAt: quiz.started_at,
      finishedAt: quiz.finished_at,
      questionCount: questions.length,
      currentIndex: quiz.current_index,
      reviewPosition: quiz.review_position,
    },
    serverTime: new Date().toISOString(),
    phase,
    // While a question is open the running tally is withheld, even from the
    // instructor. It would otherwise be projected, and a class that can watch
    // the votes accumulate will drift towards the majority instead of
    // answering independently. The correct answer is held back for the same
    // reason. Both arrive the moment the question closes.
    current: question ? publicQuestion(question, { includeAnswer: phase === 'closed' }) : null,
    // A bare count of who has answered is safe: it says nothing about what
    // anyone chose, and the instructor needs it to judge when to close early.
    answered: question
      ? Number(query.get('SELECT COUNT(*) AS n FROM answer WHERE question_id = ?', question.id).n)
      : 0,
    // Standings are likewise held until the question closes.
    standingsVisible: quiz.status === 'finished' || !question || phase === 'closed',
    review: review ? publicQuestion(review, { includeAnswer: true }) : null,
    // The host screen is normally on a projector, so the whole room can read
    // it. Student IDs are therefore left out entirely; they remain in
    // exports and in the JSON archive, which only the instructor sees.
    participants: participants.map((row) => ({
      id: row.id,
      rank: row.rank,
      nickname: row.nickname,
      score: row.score,
      correct: row.correct_count,
      answered: row.answered_count,
    })),
    // For the same reason the text of a question nobody has been shown yet is
    // withheld, rather than merely hidden in the page: a projected outline
    // would otherwise give away every answer before it is asked. Once a
    // question has been released, or the quiz is over, there is nothing left
    // to spoil and the text comes back for review.
    outline: questions.map((row) => {
      const revealed = Boolean(row.released_at) || quiz.status === 'finished';
      return {
        position: row.position,
        prompt: revealed ? row.prompt.slice(0, 120) : null,
        timeLimit: row.time_limit,
        released: Boolean(row.released_at),
        closed: Boolean(row.closed_at),
        correctRate: correctRate(row),
      };
    }),
  };
}

function correctRate(questionRow) {
  const total = Number(query.get('SELECT COUNT(*) AS n FROM answer WHERE question_id = ?', questionRow.id).n);
  if (!total) return null;
  const right = Number(
    query.get('SELECT COUNT(*) AS n FROM answer WHERE question_id = ? AND correct = 1', questionRow.id).n,
  );
  return Math.round((right / total) * 100);
}

/** What one student's phone should render right now. */
function playerState(quiz, participant) {
  const questions = questionsFor(quiz.id);
  const question = currentQuestion(quiz);
  const phase = phaseOf(question);
  const closed = phase === 'closed';
  const review = quiz.review_position
    ? query.get('SELECT * FROM quiz_question WHERE quiz_id = ? AND position = ?', quiz.id, quiz.review_position)
    : null;

  const myAnswer = question
    ? query.get(
        'SELECT choice_index, correct, points FROM answer WHERE question_id = ? AND participant_id = ?',
        question.id,
        participant.id,
      )
    : null;

  const ranked = leaderboardRows(quiz.id);
  const me = ranked.find((row) => row.id === participant.id);
  const rankingAllowed = question ? Boolean(question.show_ranking) : true;
  const showStandings = quiz.status === 'finished' || (closed && rankingAllowed);

  return {
    quiz: {
      code: quiz.code,
      name: quiz.name,
      status: quiz.status,
      questionCount: questions.length,
      currentIndex: quiz.current_index,
    },
    serverTime: new Date().toISOString(),
    phase: quiz.status === 'finished' ? 'finished' : phase,
    me: {
      nickname: participant.nickname,
      score: me ? me.score : 0,
      rank: me ? me.rank : null,
      total: ranked.length,
    },
    // The answer is only ever sent after the question closes.
    current: question ? publicQuestion(question, { includeAnswer: closed }) : null,
    myAnswer: myAnswer
      ? { choiceIndex: myAnswer.choice_index, correct: Boolean(myAnswer.correct), points: myAnswer.points }
      : null,
    showStandings,
    standings: showStandings ? publicLeaderboard(quiz.id, 10) : null,
    review: review && quiz.status === 'finished' ? publicQuestion(review, { includeAnswer: true }) : null,
    participantCount: ranked.length,
  };
}

/** Minimal payload for the lobby screen before a student has joined. */
function lobbyState(quiz) {
  return {
    code: quiz.code,
    name: quiz.name,
    status: quiz.status,
    open: isOpen(quiz),
    participantCount: Number(query.get('SELECT COUNT(*) AS n FROM participant WHERE quiz_id = ?', quiz.id).n),
  };
}

// --- records and exports ----------------------------------------------------

/** Full structured record: the JSON archive and the JSON export share it. */
function buildRecord(quiz) {
  const questions = questionsFor(quiz.id);
  const participants = leaderboardRows(quiz.id);

  return {
    format: 'tempoquiz.record.v1',
    generatedAt: nowIso(),
    quiz: {
      code: quiz.code,
      name: quiz.name,
      slug: quiz.slug,
      status: quiz.status,
      createdAt: quiz.created_at,
      createdDate: quiz.created_date,
      openedAt: quiz.opened_at,
      startedAt: quiz.started_at,
      finishedAt: quiz.finished_at,
      questionCount: questions.length,
    },
    questions: questions.map((row) => {
      const options = parseOptions(row);
      const tally = optionTally(row.id);
      return {
        position: row.position,
        bankQuestionId: row.bank_question_id,
        prompt: row.prompt,
        imageUrl: row.image_url,
        imageAlt: row.image_alt,
        timeLimit: row.time_limit,
        reveal: row.reveal,
        showRanking: Boolean(row.show_ranking),
        options: options.map((option, index) => ({
          index,
          text: option.text,
          correct: index === row.answer_index,
          chosenBy: tally.get(index) || 0,
        })),
        answerIndex: row.answer_index,
        releasedAt: row.released_at,
        closedAt: row.closed_at,
        correctRate: correctRate(row),
      };
    }),
    participants: participants.map((row) => ({
      rank: row.rank,
      nickname: row.nickname,
      studentId: row.student_id,
      score: row.score,
      correct: row.correct_count,
      answered: row.answered_count,
      totalMs: row.total_ms,
    })),
    answers: query.all(
      `SELECT p.nickname, p.student_id AS studentId, q.position, a.choice_index AS choiceIndex,
              a.correct, a.points, a.ms_taken AS msTaken, a.answered_at AS answeredAt
         FROM answer a
         JOIN participant p ON p.id = a.participant_id
         JOIN quiz_question q ON q.id = a.question_id
        WHERE a.quiz_id = ? ORDER BY q.position, a.answered_at`,
      quiz.id,
    ).map((row) => ({ ...row, correct: Boolean(row.correct) })),
  };
}

/**
 * Writes the JSON record to disk. Called on create, append and finish so the
 * archive is never more than one action behind the database.
 */
function writeArchiveFor(quiz) {
  try {
    const relative = archive.writeArchive(quiz, buildRecord(quiz));
    query.run('UPDATE quiz SET archive_path = ? WHERE id = ?', relative, quiz.id);
    return relative;
  } catch (error) {
    // A failed archive write must not take a live quiz down with it.
    console.error(`[archive] could not write record for ${quiz.code}:`, error.message);
    return null;
  }
}

function exportMarkdown(quiz) {
  const record = buildRecord(quiz);
  const quizMd = md.serializeQuiz(quiz.name, questionsFor(quiz.id).map((row) => ({
    prompt: row.prompt,
    timeLimit: row.time_limit,
    imageUrl: row.image_url,
    imageAlt: row.image_alt,
    reveal: row.reveal,
    showRanking: Boolean(row.show_ranking),
    options: parseOptions(row),
    answerIndex: row.answer_index,
  })));

  const lines = [
    quizMd.trimEnd(),
    '',
    '## Results',
    '',
    `- Room code: ${quiz.code}`,
    `- Created: ${quiz.created_at}`,
    `- Finished: ${quiz.finished_at || 'not finished'}`,
    `- Participants: ${record.participants.length}`,
    '',
    '| Rank | Nickname | Student ID | Score | Correct | Answered |',
    '| ---: | :------- | :--------- | ----: | ------: | -------: |',
    ...record.participants.map((p) => `| ${p.rank} | ${p.nickname} | ${p.studentId} | ${p.score} | ${p.correct} | ${p.answered} |`),
    '',
    '## Question performance',
    '',
    '| # | Correct rate | Question |',
    '| -: | -----------: | :------- |',
    ...record.questions.map((q) => `| ${q.position} | ${q.correctRate === null ? '—' : `${q.correctRate}%`} | ${q.prompt.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    '',
  ];
  return lines.join('\n');
}

function exportCsv(quiz) {
  const record = buildRecord(quiz);
  const questions = record.questions;
  const header = [
    'rank', 'nickname', 'student_id', 'score', 'correct', 'answered',
    ...questions.map((q) => `q${q.position}_choice`),
    ...questions.map((q) => `q${q.position}_points`),
  ];

  const byStudent = new Map();
  for (const answer of record.answers) {
    const key = JSON.stringify([answer.nickname, answer.studentId]);
    if (!byStudent.has(key)) byStudent.set(key, new Map());
    byStudent.get(key).set(answer.position, answer);
  }

  const rows = [header];
  for (const p of record.participants) {
    const answers = byStudent.get(JSON.stringify([p.nickname, p.studentId])) || new Map();
    rows.push([
      p.rank, p.nickname, p.studentId, p.score, p.correct, p.answered,
      ...questions.map((q) => {
        const a = answers.get(q.position);
        if (!a) return '';
        const letter = String.fromCharCode(65 + a.choiceIndex);
        return `${letter}${a.correct ? '' : ' (wrong)'}`;
      }),
      ...questions.map((q) => {
        const a = answers.get(q.position);
        return a ? a.points : 0;
      }),
    ]);
  }
  return csvRows(rows);
}

// --- admin management -------------------------------------------------------

function listQuizzes({ limit = 100, status } = {}) {
  // 'prepared' and 'lobby' are both status='lobby' underneath; what separates
  // them is whether the room has been opened.
  let where = '';
  let params = [];
  if (status === 'prepared') {
    where = "WHERE z.status = 'lobby' AND z.opened_at IS NULL";
  } else if (status === 'lobby') {
    where = "WHERE z.status = 'lobby' AND z.opened_at IS NOT NULL";
  } else if (status) {
    where = 'WHERE z.status = ?';
    params = [status];
  }
  return query.all(
    `SELECT z.*,
            (SELECT COUNT(*) FROM quiz_question q WHERE q.quiz_id = z.id) AS question_count,
            (SELECT COUNT(*) FROM participant p WHERE p.quiz_id = z.id) AS participant_count
       FROM quiz z ${where} ORDER BY z.created_at DESC LIMIT ?`,
    ...params,
    Math.min(500, Math.max(1, Number(limit) || 100)),
  ).map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    open: Boolean(row.opened_at),
    // What the console shows in the status column. A quiz sitting in 'lobby'
    // that has never been opened is still being prepared, and reads very
    // differently from one with a room full of students waiting in it.
    displayStatus: row.status === 'lobby' && !row.opened_at ? 'prepared' : row.status,
    createdAt: row.created_at,
    createdDate: row.created_date,
    openedAt: row.opened_at,
    finishedAt: row.finished_at,
    questionCount: Number(row.question_count),
    participantCount: Number(row.participant_count),
    archivePath: row.archive_path,
  }));
}

/**
 * Deletes a quiz and its answers. Bank usage rows survive by design: the
 * questions were still shown to a class, so they must not come back.
 */
function deleteQuiz(id, { deleteArchiveFile = false } = {}) {
  const quiz = getQuizById(id);
  if (!quiz) throw notFound('That quiz no longer exists.');
  if (deleteArchiveFile && quiz.archive_path) archive.deleteArchive(quiz.archive_path);
  query.run('DELETE FROM quiz WHERE id = ?', id);
  return true;
}

/** Issues a replacement host token, for recovering a lost tab. */
function rotateHostToken(quiz) {
  const token = randomToken(32);
  query.run('UPDATE quiz SET host_token_hash = ? WHERE id = ?', sha256(token), quiz.id);
  return token;
}

module.exports = {
  getQuizByCode,
  getQuizById,
  requireQuiz,
  requireHost,
  questionsFor,
  createQuiz,
  createFromMarkdown,
  createFromBank,
  appendQuestions,
  isOpen,
  openRoom,
  closeRoom,
  releaseNext,
  closeCurrent,
  finishQuiz,
  setReview,
  currentQuestion,
  phaseOf,
  joinQuiz,
  participantFromToken,
  submitAnswer,
  hostState,
  playerState,
  lobbyState,
  publicLeaderboard,
  leaderboardRows,
  buildRecord,
  writeArchiveFor,
  exportMarkdown,
  exportCsv,
  listQuizzes,
  deleteQuiz,
  rotateHostToken,
};
