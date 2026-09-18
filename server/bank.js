'use strict';

const { query, transaction } = require('./db');
const md = require('./markdown');
const {
  nowIso,
  fingerprintQuestion,
  clampInt,
  badRequest,
  notFound,
  conflict,
} = require('./util');

const DIFFICULTIES = ['easy', 'medium', 'hard'];

/**
 * Validates and normalises a question coming from the bank editor, a Markdown
 * import, or the API. Throws HttpError with a specific message on bad input.
 */
function normaliseQuestion(input, { context = 'Question' } = {}) {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt) throw badRequest(`${context}: question text is required.`);
  if (prompt.length > 2000) throw badRequest(`${context}: question text must be 2000 characters or fewer.`);

  const rawOptions = Array.isArray(input.options) ? input.options : [];
  const options = rawOptions
    .map((option) => (typeof option === 'string'
      ? { text: option.trim(), correct: false }
      : { text: String(option.text ?? '').trim(), correct: Boolean(option.correct) }))
    .filter((option) => option.text.length > 0);

  if (options.length < md.MIN_OPTIONS || options.length > md.MAX_OPTIONS) {
    throw badRequest(`${context}: provide between ${md.MIN_OPTIONS} and ${md.MAX_OPTIONS} answer options (got ${options.length}).`);
  }
  if (options.some((option) => option.text.length > 500)) {
    throw badRequest(`${context}: each option must be 500 characters or fewer.`);
  }
  const seen = new Set();
  for (const option of options) {
    const key = option.text.toLowerCase();
    if (seen.has(key)) throw badRequest(`${context}: the option "${option.text}" appears twice.`);
    seen.add(key);
  }

  // The correct answer may arrive either as a flag on the option or as an index.
  let answerIndex = options.findIndex((option) => option.correct);
  if (answerIndex === -1 && input.answerIndex !== undefined && input.answerIndex !== null) {
    answerIndex = Number.parseInt(input.answerIndex, 10);
  }
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= options.length) {
    throw badRequest(`${context}: mark exactly one option as the correct answer.`);
  }
  if (options.filter((option) => option.correct).length > 1) {
    throw badRequest(`${context}: only one option may be marked correct.`);
  }
  options.forEach((option, index) => {
    option.correct = index === answerIndex;
  });

  // Range-checked rather than clamped: silently turning a requested 2 seconds
  // into 10 would leave the instructor believing they had set something else.
  const timeLimit = Number.parseInt(input.timeLimit ?? input.time_limit, 10);
  if (!Number.isInteger(timeLimit) || timeLimit < md.MIN_TIME || timeLimit > md.MAX_TIME) {
    throw badRequest(`${context}: time limit must be a whole number between ${md.MIN_TIME} and ${md.MAX_TIME} seconds.`);
  }

  let imageUrl = null;
  let imageAlt = null;
  const rawImage = String(input.imageUrl ?? input.image_url ?? '').trim();
  if (rawImage) {
    const check = md.validateImageUrl(rawImage);
    if (!check.ok) throw badRequest(`${context}: ${check.reason}`);
    imageUrl = check.value;
    imageAlt = String(input.imageAlt ?? input.image_alt ?? '').trim();
    if (!imageAlt) throw badRequest(`${context}: alt text is required when an image is used.`);
    if (imageAlt.length > 300) throw badRequest(`${context}: image alt must be 300 characters or fewer.`);
  }

  const reveal = String(input.reveal ?? 'show').toLowerCase();
  if (reveal !== 'show' && reveal !== 'slow') {
    throw badRequest(`${context}: reveal must be "show" or "slow".`);
  }

  const difficulty = String(input.difficulty ?? 'medium').toLowerCase();
  if (!DIFFICULTIES.includes(difficulty)) {
    throw badRequest(`${context}: difficulty must be easy, medium or hard.`);
  }

  const topic = String(input.topic ?? 'General').trim().slice(0, 60) || 'General';
  const showRankingRaw = input.showRanking ?? input.show_ranking ?? true;
  const showRanking = showRankingRaw === false || showRankingRaw === 0 || showRankingRaw === '0' || showRankingRaw === 'no'
    ? 0
    : 1;

  return {
    topic,
    difficulty,
    prompt,
    imageUrl,
    imageAlt,
    timeLimit,
    reveal,
    showRanking,
    options,
    answerIndex,
    notes: String(input.notes ?? '').trim().slice(0, 500) || null,
    fingerprint: fingerprintQuestion(prompt, options),
  };
}

/** Expands a stored row into the shape the API and front end expect. */
function rowToQuestion(row) {
  if (!row) return null;
  let options = [];
  try {
    options = JSON.parse(row.options_json);
  } catch {
    options = [];
  }
  const useCount = Number(row.use_count ?? row.times_used ?? 0);
  const reserved = Number(row.reserved_count ?? 0);
  let status = 'available';
  if (row.retired) status = 'retired';
  else if (useCount > 0) status = 'used';
  else if (reserved > 0) status = 'reserved';

  return {
    id: row.id,
    topic: row.topic,
    difficulty: row.difficulty,
    prompt: row.prompt,
    imageUrl: row.image_url,
    imageAlt: row.image_alt,
    timeLimit: row.time_limit,
    reveal: row.reveal,
    showRanking: Boolean(row.show_ranking),
    options,
    answerIndex: row.answer_index,
    notes: row.notes,
    status,
    useCount,
    reservedCount: reserved,
    retired: Boolean(row.retired),
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// A question counts as "used" once a class has actually seen it, and
// "reserved" while it sits in a quiz that has not been run yet. Both are
// excluded when drawing fresh questions.
const SELECT_WITH_USAGE = `
  SELECT q.*,
         (SELECT COUNT(*) FROM bank_usage u WHERE u.question_id = q.id) AS use_count,
         (SELECT COUNT(*) FROM quiz_question qq
             JOIN quiz z ON z.id = qq.quiz_id
            WHERE qq.bank_question_id = q.id
              AND z.status IN ('lobby', 'running')
              AND qq.released_at IS NULL) AS reserved_count
    FROM bank_question q
`;

function getQuestion(id) {
  return rowToQuestion(query.get(`${SELECT_WITH_USAGE} WHERE q.id = ?`, id));
}

/** Shared filter builder so list and count always agree on what matches. */
function buildFilter(filters = {}) {
  const where = [];
  const params = [];

  if (filters.topic) {
    where.push('q.topic = ?');
    params.push(filters.topic);
  }
  if (filters.difficulty && DIFFICULTIES.includes(filters.difficulty)) {
    where.push('q.difficulty = ?');
    params.push(filters.difficulty);
  }
  if (filters.search) {
    where.push('(q.prompt LIKE ? ESCAPE \'\\\' OR q.options_json LIKE ? ESCAPE \'\\\')');
    const needle = `%${String(filters.search).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(needle, needle);
  }
  if (filters.status === 'available') {
    where.push('q.retired = 0 AND use_count = 0 AND reserved_count = 0');
  } else if (filters.status === 'used') {
    where.push('use_count > 0');
  } else if (filters.status === 'reserved') {
    where.push('use_count = 0 AND reserved_count > 0');
  } else if (filters.status === 'retired') {
    where.push('q.retired = 1');
  } else if (!filters.includeRetired) {
    where.push('q.retired = 0');
  }

  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function listQuestions(filters = {}) {
  const { clause, params } = buildFilter(filters);
  const limit = clampInt(filters.limit, 1, 500, 200);
  const offset = clampInt(filters.offset, 0, 1_000_000, 0);
  const rows = query.all(
    `${SELECT_WITH_USAGE} ${clause}
      ORDER BY q.topic COLLATE NOCASE, q.id DESC
      LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  return rows.map(rowToQuestion);
}

/** Total matching rows, ignoring the page window, for pagination. */
function countQuestions(filters = {}) {
  const { clause, params } = buildFilter(filters);
  const row = query.get(`SELECT COUNT(*) AS n FROM (${SELECT_WITH_USAGE} ${clause})`, ...params);
  return Number(row ? row.n : 0);
}

function createQuestion(input) {
  const q = normaliseQuestion(input);
  const existing = query.get('SELECT id FROM bank_question WHERE fingerprint = ?', q.fingerprint);
  if (existing) {
    throw conflict('That question is already in the bank.', { existingId: existing.id });
  }
  const at = nowIso();
  const result = query.run(
    `INSERT INTO bank_question
       (topic, difficulty, prompt, image_url, image_alt, time_limit, reveal, show_ranking,
        options_json, answer_index, fingerprint, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    q.topic, q.difficulty, q.prompt, q.imageUrl, q.imageAlt, q.timeLimit, q.reveal,
    q.showRanking, JSON.stringify(q.options), q.answerIndex, q.fingerprint, q.notes, at, at,
  );
  return getQuestion(Number(result.lastInsertRowid));
}

function updateQuestion(id, input) {
  const current = query.get('SELECT * FROM bank_question WHERE id = ?', id);
  if (!current) throw notFound('That question is not in the bank.');

  const q = normaliseQuestion(input);
  const clash = query.get(
    'SELECT id FROM bank_question WHERE fingerprint = ? AND id <> ?',
    q.fingerprint,
    id,
  );
  if (clash) throw conflict('Another question in the bank already has that text.', { existingId: clash.id });

  query.run(
    `UPDATE bank_question
        SET topic = ?, difficulty = ?, prompt = ?, image_url = ?, image_alt = ?, time_limit = ?,
            reveal = ?, show_ranking = ?, options_json = ?, answer_index = ?, fingerprint = ?,
            notes = ?, updated_at = ?
      WHERE id = ?`,
    q.topic, q.difficulty, q.prompt, q.imageUrl, q.imageAlt, q.timeLimit, q.reveal,
    q.showRanking, JSON.stringify(q.options), q.answerIndex, q.fingerprint, q.notes, nowIso(), id,
  );
  return getQuestion(id);
}

/** Validates one Markdown question block, then applies it to an existing row. */
function updateQuestionMarkdown(id, markdown) {
  const parsed = md.parseQuestionBlocks(markdown);
  if (parsed.errors.length) {
    throw badRequest('The Markdown has validation problems. Fix them and save again.', {
      errors: parsed.errors,
    });
  }
  if (parsed.questions.length !== 1) {
    throw badRequest('Edit exactly one question at a time.');
  }
  return updateQuestion(id, parsed.questions[0]);
}

function setRetired(id, retired) {
  const current = query.get('SELECT id FROM bank_question WHERE id = ?', id);
  if (!current) throw notFound('That question is not in the bank.');
  query.run('UPDATE bank_question SET retired = ?, updated_at = ? WHERE id = ?', retired ? 1 : 0, nowIso(), id);
  return getQuestion(id);
}

function deleteQuestion(id) {
  const current = query.get('SELECT id FROM bank_question WHERE id = ?', id);
  if (!current) throw notFound('That question is not in the bank.');
  const used = query.get('SELECT COUNT(*) AS n FROM bank_usage WHERE question_id = ?', id);
  if (Number(used.n) > 0) {
    // Deleting would drop the record that this question has already been asked,
    // which is exactly the history the no-repeat rule depends on.
    throw conflict('This question has already been used in a quiz. Retire it instead of deleting, so it is never asked again.');
  }
  query.run('DELETE FROM bank_question WHERE id = ?', id);
  return true;
}

/** Where a question has been used before; drives the reuse warnings. */
function usageHistory(questionId) {
  return query.all(
    `SELECT quiz_name, quiz_code, used_at
       FROM bank_usage WHERE question_id = ? ORDER BY used_at DESC`,
    questionId,
  );
}

/**
 * Records that a question was shown to a class. Called when a question is
 * released, not when it is added to a quiz, so a quiz that is built and then
 * abandoned does not burn its questions.
 */
function recordUsage(questionId, quiz) {
  if (!questionId) return;
  const at = nowIso();
  const already = query.get(
    'SELECT id FROM bank_usage WHERE question_id = ? AND quiz_id = ?',
    questionId,
    quiz.id,
  );
  if (already) return;
  query.run(
    'INSERT INTO bank_usage (question_id, quiz_id, quiz_name, quiz_code, used_at) VALUES (?, ?, ?, ?, ?)',
    questionId, quiz.id, quiz.name, quiz.code, at,
  );
  query.run(
    'UPDATE bank_question SET times_used = times_used + 1, last_used_at = ? WHERE id = ?',
    at,
    questionId,
  );
}

/**
 * Given parsed questions, reports which ones match something already in the
 * bank and whether that entry has been used before. This is what warns an
 * instructor that a pasted quiz repeats last week's material.
 */
function checkReuse(questions) {
  return questions.map((question, index) => {
    const fingerprint = fingerprintQuestion(question.prompt, question.options);
    const row = query.get(
      `${SELECT_WITH_USAGE} WHERE q.fingerprint = ?`,
      fingerprint,
    );
    if (!row) {
      return { index, position: question.position ?? index + 1, known: false, used: false };
    }
    const entry = rowToQuestion(row);
    return {
      index,
      position: question.position ?? index + 1,
      known: true,
      bankId: entry.id,
      status: entry.status,
      used: entry.useCount > 0,
      retired: entry.retired,
      history: entry.useCount > 0 ? usageHistory(entry.id) : [],
    };
  });
}

/** Randomly draws questions that have never been used and are not reserved. */
function draw({ topic, difficulty, count = 5 } = {}) {
  const where = ['q.retired = 0', 'use_count = 0', 'reserved_count = 0'];
  const params = [];
  if (topic) {
    where.push('q.topic = ?');
    params.push(topic);
  }
  if (difficulty && DIFFICULTIES.includes(difficulty)) {
    where.push('q.difficulty = ?');
    params.push(difficulty);
  }
  const wanted = clampInt(count, 1, md.MAX_QUESTIONS, 5);
  // RANDOM() is fine here: the bank is at most a few thousand rows.
  const rows = query.all(
    `${SELECT_WITH_USAGE} WHERE ${where.join(' AND ')} ORDER BY RANDOM() LIMIT ?`,
    ...params,
    wanted,
  );
  return rows.map(rowToQuestion);
}

function topics() {
  return query.all(
    `SELECT topic AS name, COUNT(*) AS total,
            SUM(CASE WHEN retired = 0 AND times_used = 0 THEN 1 ELSE 0 END) AS fresh
       FROM bank_question GROUP BY topic ORDER BY topic COLLATE NOCASE`,
  ).map((row) => ({ name: row.name, total: Number(row.total), fresh: Number(row.fresh) }));
}

function stats() {
  const row = query.get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN retired = 1 THEN 1 ELSE 0 END) AS retired,
            SUM(CASE WHEN times_used > 0 THEN 1 ELSE 0 END) AS used
       FROM bank_question`,
  );
  const reserved = query.get(
    `SELECT COUNT(DISTINCT qq.bank_question_id) AS n
       FROM quiz_question qq JOIN quiz z ON z.id = qq.quiz_id
      WHERE qq.bank_question_id IS NOT NULL
        AND z.status IN ('lobby', 'running') AND qq.released_at IS NULL`,
  );
  const total = Number(row.total || 0);
  const used = Number(row.used || 0);
  const retired = Number(row.retired || 0);
  const reservedCount = Number(reserved.n || 0);
  return {
    total,
    used,
    retired,
    reserved: reservedCount,
    available: Math.max(0, total - used - retired - reservedCount),
  };
}

/**
 * Bulk-imports Markdown into the bank. Questions already present are reported
 * as duplicates rather than added again, so re-importing a file is harmless.
 */
function importMarkdown(markdown, { topic, difficulty } = {}) {
  const parsed = md.parseQuiz(markdown, { requireTitle: false });
  if (parsed.errors.length) {
    throw badRequest('The Markdown has validation problems. Fix them and import again.', {
      errors: parsed.errors,
    });
  }
  if (!parsed.questions.length) throw badRequest('No questions found in that Markdown.');

  const added = [];
  const duplicates = [];

  transaction(() => {
    parsed.questions.forEach((question, index) => {
      const payload = {
        ...question,
        topic: question.topic || topic || parsed.title || 'General',
        difficulty: question.difficulty || difficulty || 'medium',
      };
      try {
        added.push(createQuestion(payload));
      } catch (error) {
        if (error.status === 409) {
          duplicates.push({
            position: index + 1,
            prompt: question.prompt.slice(0, 120),
            existingId: error.details ? error.details.existingId : null,
          });
        } else {
          throw error;
        }
      }
    });
  });

  return { added, duplicates, total: parsed.questions.length };
}

/** Serialises the whole bank (or one topic) back to Markdown for backup. */
function exportMarkdown({ topic, includeRetired = false } = {}) {
  const questions = listQuestions({ topic, includeRetired, limit: 500 });
  const title = topic ? `Question bank — ${topic}` : 'Question bank';
  return md.serializeQuiz(title, questions);
}

module.exports = {
  DIFFICULTIES,
  normaliseQuestion,
  rowToQuestion,
  getQuestion,
  listQuestions,
  countQuestions,
  createQuestion,
  updateQuestion,
  updateQuestionMarkdown,
  deleteQuestion,
  setRetired,
  usageHistory,
  recordUsage,
  checkReuse,
  draw,
  topics,
  stats,
  importMarkdown,
  exportMarkdown,
};
