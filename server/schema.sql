-- TempoQuiz schema.
-- Every table is created with explicit constraints so that invalid quiz state
-- is rejected by the database itself, not only by application code.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Exactly one administrator account. The CHECK on the primary key is what
-- enforces "single shared login" at the storage layer.
CREATE TABLE IF NOT EXISTS admin_account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  username      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  must_change   INTEGER NOT NULL DEFAULT 0 CHECK (must_change IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_session (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_session_expiry ON admin_session (expires_at);

CREATE TABLE IF NOT EXISTS login_attempt (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ip       TEXT NOT NULL,
  username TEXT,
  ok       INTEGER NOT NULL CHECK (ok IN (0, 1)),
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempt_ip ON login_attempt (ip, at);

-- ---------------------------------------------------------------------------
-- Question bank
-- ---------------------------------------------------------------------------

-- fingerprint is UNIQUE, so the same question cannot be stored twice even if
-- it is re-imported with different spacing or capitalisation.
CREATE TABLE IF NOT EXISTS bank_question (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  topic        TEXT NOT NULL DEFAULT 'General',
  difficulty   TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy', 'medium', 'hard')),
  prompt       TEXT NOT NULL,
  image_url    TEXT,
  image_alt    TEXT,
  time_limit   INTEGER NOT NULL CHECK (time_limit BETWEEN 10 AND 600),
  reveal       TEXT NOT NULL DEFAULT 'show' CHECK (reveal IN ('show', 'slow')),
  show_ranking INTEGER NOT NULL DEFAULT 1 CHECK (show_ranking IN (0, 1)),
  options_json TEXT NOT NULL,
  answer_index INTEGER NOT NULL CHECK (answer_index >= 0),
  fingerprint  TEXT NOT NULL UNIQUE,
  times_used   INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  retired      INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_topic ON bank_question (topic);
CREATE INDEX IF NOT EXISTS idx_bank_used ON bank_question (times_used);

-- ---------------------------------------------------------------------------
-- Quizzes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS quiz (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby', 'running', 'finished')),
  host_token_hash TEXT NOT NULL,
  current_index   INTEGER NOT NULL DEFAULT -1,
  review_position INTEGER,
  archive_path    TEXT,
  created_at      TEXT NOT NULL,
  created_date    TEXT NOT NULL,
  -- Null until the instructor opens the room. A quiz can therefore be written
  -- and arranged days before the lecture without its code being joinable in
  -- the meantime. Status stays 'lobby' throughout; opening is not a status of
  -- its own because the CHECK above is baked into databases already in use.
  opened_at       TEXT,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_quiz_created ON quiz (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quiz_status ON quiz (status);

CREATE TABLE IF NOT EXISTS quiz_question (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id          INTEGER NOT NULL REFERENCES quiz (id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  bank_question_id INTEGER REFERENCES bank_question (id) ON DELETE SET NULL,
  prompt           TEXT NOT NULL,
  image_url        TEXT,
  image_alt        TEXT,
  time_limit       INTEGER NOT NULL CHECK (time_limit BETWEEN 10 AND 600),
  reveal           TEXT NOT NULL DEFAULT 'show' CHECK (reveal IN ('show', 'slow')),
  show_ranking     INTEGER NOT NULL DEFAULT 1 CHECK (show_ranking IN (0, 1)),
  options_json     TEXT NOT NULL,
  answer_index     INTEGER NOT NULL,
  released_at      TEXT,
  ends_at          TEXT,
  closed_at        TEXT,
  UNIQUE (quiz_id, position)
);

-- A quiz keeps its own copy of every question it asked. Editing or deleting a
-- bank entry later can never rewrite the record of what a class actually saw.

-- Usage log backing the "never ask the same question twice" rule. quiz_id is
-- SET NULL on delete but the row survives, because a question shown to a class
-- has been used whether or not the quiz record is still kept.
CREATE TABLE IF NOT EXISTS bank_usage (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES bank_question (id) ON DELETE CASCADE,
  quiz_id     INTEGER REFERENCES quiz (id) ON DELETE SET NULL,
  quiz_name   TEXT NOT NULL,
  quiz_code   TEXT NOT NULL,
  used_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_usage_question ON bank_usage (question_id);

CREATE TABLE IF NOT EXISTS participant (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id    INTEGER NOT NULL REFERENCES quiz (id) ON DELETE CASCADE,
  nickname   TEXT NOT NULL,
  student_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  score      INTEGER NOT NULL DEFAULT 0,
  joined_at  TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  UNIQUE (quiz_id, nickname, student_id)
);
CREATE INDEX IF NOT EXISTS idx_participant_quiz ON participant (quiz_id, score DESC);

-- UNIQUE (question_id, participant_id) is the one-answer-only rule. It is a
-- database constraint rather than an application check so that two racing
-- submissions from the same phone cannot both be recorded.
CREATE TABLE IF NOT EXISTS answer (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id        INTEGER NOT NULL REFERENCES quiz (id) ON DELETE CASCADE,
  question_id    INTEGER NOT NULL REFERENCES quiz_question (id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participant (id) ON DELETE CASCADE,
  choice_index   INTEGER NOT NULL,
  correct        INTEGER NOT NULL CHECK (correct IN (0, 1)),
  ms_taken       INTEGER NOT NULL,
  points         INTEGER NOT NULL,
  answered_at    TEXT NOT NULL,
  UNIQUE (question_id, participant_id)
);
CREATE INDEX IF NOT EXISTS idx_answer_question ON answer (question_id);
