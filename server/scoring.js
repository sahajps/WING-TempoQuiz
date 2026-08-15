'use strict';

const BASE_POINTS = 500;
const SPEED_POINTS = 500;

/**
 * A correct answer is worth 500 points plus up to 500 more for speed, awarded
 * on a straight line from the moment the question opened to the moment it
 * closes. Answering the instant it opens is worth the full 1000; answering as
 * the timer expires is worth 500. Wrong answers score nothing.
 *
 * @param {boolean} correct
 * @param {number} msTaken     milliseconds from question release to submission
 * @param {number} timeLimitS  question time limit in seconds
 */
function scoreAnswer(correct, msTaken, timeLimitS) {
  if (!correct) return 0;
  const windowMs = Math.max(1, Number(timeLimitS) * 1000);
  const elapsed = Math.min(Math.max(0, Number(msTaken) || 0), windowMs);
  const speed = Math.round(SPEED_POINTS * (1 - elapsed / windowMs));
  return BASE_POINTS + Math.max(0, Math.min(SPEED_POINTS, speed));
}

/**
 * Orders participants for display: highest score first, then whoever got there
 * with less total time spent answering, then alphabetically so the order is
 * stable across polls rather than jittering between refreshes.
 */
function rankParticipants(rows) {
  const sorted = [...rows].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.total_ms ?? 0;
    const bt = b.total_ms ?? 0;
    if (at !== bt) return at - bt;
    return String(a.nickname).localeCompare(String(b.nickname));
  });

  let lastScore = null;
  let lastMs = null;
  let lastRank = 0;
  return sorted.map((row, index) => {
    // A rank is shared only by a genuine dead heat — same score AND same total
    // time. Two students on equal points but different times are not tied,
    // because time is what decided their order. The next distinct entry skips
    // ahead, so a shared 1st is followed by 3rd.
    const ms = row.total_ms ?? 0;
    const tied = row.score === lastScore && ms === lastMs;
    const rank = tied ? lastRank : index + 1;
    lastScore = row.score;
    lastMs = ms;
    lastRank = rank;
    return { ...row, rank };
  });
}

module.exports = { BASE_POINTS, SPEED_POINTS, scoreAnswer, rankParticipants };
