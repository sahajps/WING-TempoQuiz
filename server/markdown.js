'use strict';

const MIN_OPTIONS = 4;
const MAX_OPTIONS = 6;
const MIN_TIME = 10;
const MAX_TIME = 600;
const MAX_QUESTIONS = 100;
const MAX_PROMPT = 2000;
const MAX_OPTION = 500;

const META_KEYS = new Set([
  'time',
  'image',
  'image alt',
  'reveal',
  'show ranking',
  'topic',
  'difficulty',
]);

/**
 * Question images may be hotlinked from elsewhere or served from this app, but
 * anything that could execute (javascript:, data:, vbscript:) is refused.
 */
function validateImageUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, reason: 'Image is empty.' };
  if (value.startsWith('/') && !value.startsWith('//')) {
    return { ok: true, value };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'Image must be an http(s) URL or a root-relative path starting with "/".' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Image protocol "${parsed.protocol}" is not allowed. Use http or https.` };
  }
  return { ok: true, value: parsed.toString() };
}

/** Matches `**Key:** value`, tolerating missing bold markers and stray spaces. */
function matchMeta(line) {
  const bold = /^\*\*\s*([A-Za-z ]+?)\s*:\s*\*\*\s*(.*)$/.exec(line);
  if (bold) return { key: bold[1].trim().toLowerCase(), value: bold[2].trim() };
  const plain = /^([A-Za-z ]+?)\s*:\s+(.*)$/.exec(line);
  if (plain && META_KEYS.has(plain[1].trim().toLowerCase())) {
    return { key: plain[1].trim().toLowerCase(), value: plain[2].trim() };
  }
  return null;
}

/** Matches `- [ ] text` / `- [x] text`, allowing * or + as the bullet. */
function matchOption(line) {
  const m = /^[-*+]\s*\[([ xX])\]\s*(.*)$/.exec(line);
  if (!m) return null;
  return { correct: m[1].toLowerCase() === 'x', text: m[2].trim() };
}

function parseYesNo(value) {
  const v = String(value).trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'on'].includes(v)) return true;
  if (['no', 'n', 'false', '0', 'off'].includes(v)) return false;
  return null;
}

/**
 * Parses the TempoQuiz Markdown dialect.
 *
 * Returns `{ ok, title, questions, errors }` where every error carries the
 * 1-based source line, so the instructor editor can point at the exact spot.
 * Parsing never throws on malformed input; it collects problems instead.
 */
function parseQuiz(markdown, options = {}) {
  const { requireTitle = true, startPosition = 1 } = options;
  const errors = [];
  const text = String(markdown ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  let title = null;
  let titleLine = 0;
  const blocks = [];
  let current = null;

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();

    const h1 = /^#\s+(.*)$/.exec(line);
    if (h1) {
      if (title !== null) {
        errors.push({ line: lineNo, message: 'More than one quiz title. Use a single "#" heading.' });
      } else {
        title = h1[1].trim();
        titleLine = lineNo;
      }
      return;
    }

    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) {
      const label = h2[1].trim();
      const numbered = /^Question\s+(\d+)\s*$/i.exec(label);
      if (!numbered) {
        errors.push({
          line: lineNo,
          message: `Heading "## ${label}" is not recognised. Each question must start with "## Question N".`,
        });
        return;
      }
      current = {
        line: lineNo,
        declaredNumber: Number.parseInt(numbered[1], 10),
        meta: [],
        promptLines: [],
        options: [],
      };
      blocks.push(current);
      return;
    }

    if (!current) {
      if (line && !/^#/.test(line) && title === null && requireTitle) {
        errors.push({ line: lineNo, message: 'Content appears before the quiz title. Start the file with "# Quiz title".' });
      } else if (line && title !== null) {
        errors.push({ line: lineNo, message: 'Content between the title and the first question is ignored. Move it into a question.' });
      }
      return;
    }

    if (!line) {
      if (current.options.length === 0 && current.promptLines.length > 0) current.promptLines.push('');
      return;
    }

    const option = matchOption(line);
    if (option) {
      current.options.push({ ...option, line: lineNo });
      return;
    }

    if (current.options.length > 0) {
      errors.push({
        line: lineNo,
        message: 'Text appears after the answer options. Put the question text above the "- [ ]" list.',
      });
      return;
    }

    const meta = matchMeta(line);
    if (meta && META_KEYS.has(meta.key)) {
      current.meta.push({ ...meta, line: lineNo });
      return;
    }
    if (meta && current.promptLines.length === 0) {
      errors.push({
        line: lineNo,
        message: `Unknown setting "${meta.key}". Supported: Time, Image, Image alt, Reveal, Show ranking, Topic, Difficulty.`,
      });
      return;
    }

    current.promptLines.push(rawLine.trim());
  });

  if (requireTitle && title === null) {
    errors.push({ line: 1, message: 'Missing quiz title. The file must begin with "# Quiz title".' });
  }
  if (requireTitle && title !== null && !title) {
    errors.push({ line: titleLine, message: 'Quiz title is empty.' });
  }
  if (title && title.length > 150) {
    errors.push({ line: titleLine, message: 'Quiz title must be 150 characters or fewer.' });
  }
  if (blocks.length === 0) {
    errors.push({ line: 1, message: 'No questions found. Add at least one "## Question 1" block.' });
  }
  if (blocks.length > MAX_QUESTIONS) {
    errors.push({ line: 1, message: `Too many questions (${blocks.length}). The maximum is ${MAX_QUESTIONS}.` });
  }

  const questions = [];
  blocks.forEach((block, index) => {
    const position = startPosition + index;
    const expected = startPosition + index;
    if (block.declaredNumber !== expected) {
      errors.push({
        line: block.line,
        message: `Question is numbered ${block.declaredNumber} but is in position ${expected}. Number questions consecutively.`,
      });
    }

    const question = {
      position,
      prompt: block.promptLines.join('\n').trim(),
      timeLimit: null,
      imageUrl: null,
      imageAlt: null,
      reveal: 'show',
      showRanking: true,
      topic: null,
      difficulty: null,
      options: [],
      answerIndex: -1,
      line: block.line,
    };

    const seen = new Set();
    for (const meta of block.meta) {
      if (seen.has(meta.key)) {
        errors.push({ line: meta.line, message: `Setting "${meta.key}" is repeated.` });
        continue;
      }
      seen.add(meta.key);

      switch (meta.key) {
        case 'time': {
          if (!/^\d+$/.test(meta.value)) {
            errors.push({ line: meta.line, message: `Time must be a whole number of seconds, got "${meta.value}".` });
            break;
          }
          const seconds = Number.parseInt(meta.value, 10);
          if (seconds < MIN_TIME || seconds > MAX_TIME) {
            errors.push({ line: meta.line, message: `Time must be between ${MIN_TIME} and ${MAX_TIME} seconds, got ${seconds}.` });
            break;
          }
          question.timeLimit = seconds;
          break;
        }
        case 'image': {
          const check = validateImageUrl(meta.value);
          if (!check.ok) errors.push({ line: meta.line, message: check.reason });
          else question.imageUrl = check.value;
          break;
        }
        case 'image alt':
          if (meta.value.length > 300) {
            errors.push({ line: meta.line, message: 'Image alt must be 300 characters or fewer.' });
          }
          question.imageAlt = meta.value;
          break;
        case 'reveal': {
          const v = meta.value.toLowerCase();
          if (v !== 'show' && v !== 'slow') {
            errors.push({ line: meta.line, message: `Reveal must be "show" or "slow", got "${meta.value}".` });
            break;
          }
          question.reveal = v;
          break;
        }
        case 'show ranking': {
          const v = parseYesNo(meta.value);
          if (v === null) {
            errors.push({ line: meta.line, message: `Show ranking must be "yes" or "no", got "${meta.value}".` });
            break;
          }
          question.showRanking = v;
          break;
        }
        case 'topic':
          question.topic = meta.value.slice(0, 60);
          break;
        case 'difficulty': {
          const v = meta.value.toLowerCase();
          if (!['easy', 'medium', 'hard'].includes(v)) {
            errors.push({ line: meta.line, message: `Difficulty must be easy, medium or hard, got "${meta.value}".` });
            break;
          }
          question.difficulty = v;
          break;
        }
        default:
          break;
      }
    }

    if (question.timeLimit === null && !seen.has('time')) {
      errors.push({ line: block.line, message: `Question ${expected} is missing "**Time:** <seconds>".` });
    }
    if (!question.prompt) {
      errors.push({ line: block.line, message: `Question ${expected} has no question text.` });
    } else if (question.prompt.length > MAX_PROMPT) {
      errors.push({ line: block.line, message: `Question ${expected} text is longer than ${MAX_PROMPT} characters.` });
    }
    if (question.imageUrl && !question.imageAlt) {
      errors.push({ line: block.line, message: `Question ${expected} has an image but no "**Image alt:**". Alt text is required.` });
    }
    if (!question.imageUrl && question.imageAlt) {
      errors.push({ line: block.line, message: `Question ${expected} has "Image alt" but no "Image".` });
    }

    const correct = block.options.filter((o) => o.correct);
    if (block.options.length < MIN_OPTIONS || block.options.length > MAX_OPTIONS) {
      errors.push({
        line: block.line,
        message: `Question ${expected} has ${block.options.length} options. Provide between ${MIN_OPTIONS} and ${MAX_OPTIONS}.`,
      });
    }
    if (correct.length !== 1) {
      errors.push({
        line: block.line,
        message: correct.length === 0
          ? `Question ${expected} has no correct answer. Mark exactly one option with "- [x]".`
          : `Question ${expected} marks ${correct.length} options as correct. Mark exactly one.`,
      });
    }

    const texts = new Set();
    block.options.forEach((option) => {
      if (!option.text) {
        errors.push({ line: option.line, message: `Question ${expected} has an empty option.` });
      } else if (option.text.length > MAX_OPTION) {
        errors.push({ line: option.line, message: `Question ${expected} has an option longer than ${MAX_OPTION} characters.` });
      }
      const key = option.text.toLowerCase();
      if (texts.has(key)) {
        errors.push({ line: option.line, message: `Question ${expected} repeats the option "${option.text}".` });
      }
      texts.add(key);
    });

    question.options = block.options.map((o) => ({ text: o.text, correct: o.correct }));
    question.answerIndex = question.options.findIndex((o) => o.correct);
    questions.push(question);
  });

  errors.sort((a, b) => a.line - b.line);
  return { ok: errors.length === 0, title: title ?? '', questions, errors };
}

/** Parses one or more `## Question N` blocks with no `#` title, for appending. */
function parseQuestionBlocks(markdown, startPosition = 1) {
  return parseQuiz(markdown, { requireTitle: false, startPosition });
}

function escapeMetaValue(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ').trim();
}

/** Renders a single question back into the Markdown dialect. */
function serializeQuestion(question, number) {
  const out = [`## Question ${number}`];
  out.push(`**Time:** ${question.timeLimit ?? question.time_limit}`);
  const imageUrl = question.imageUrl ?? question.image_url;
  const imageAlt = question.imageAlt ?? question.image_alt;
  if (imageUrl) {
    out.push(`**Image:** ${escapeMetaValue(imageUrl)}`);
    out.push(`**Image alt:** ${escapeMetaValue(imageAlt)}`);
  }
  const reveal = question.reveal ?? 'show';
  if (reveal !== 'show') out.push(`**Reveal:** ${reveal}`);
  const showRanking = question.showRanking ?? question.show_ranking;
  const rankingOn = showRanking === undefined ? true : Boolean(Number(showRanking));
  if (!rankingOn) out.push('**Show ranking:** no');
  if (question.topic) out.push(`**Topic:** ${escapeMetaValue(question.topic)}`);
  if (question.difficulty) out.push(`**Difficulty:** ${question.difficulty}`);

  out.push('');
  out.push(String(question.prompt).trim());
  out.push('');
  const options = Array.isArray(question.options)
    ? question.options
    : JSON.parse(question.options_json || '[]');
  const answerIndex = question.answerIndex ?? question.answer_index;
  options.forEach((option, index) => {
    const text = typeof option === 'string' ? option : option.text;
    const correct = typeof option === 'string' ? index === answerIndex : Boolean(option.correct);
    out.push(`- [${correct ? 'x' : ' '}] ${text}`);
  });
  return out.join('\n');
}

/** Renders a whole quiz back into Markdown. */
function serializeQuiz(title, questions) {
  const parts = [`# ${title}`, ''];
  questions.forEach((question, index) => {
    parts.push(serializeQuestion(question, index + 1));
    parts.push('');
  });
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

module.exports = {
  MIN_OPTIONS,
  MAX_OPTIONS,
  MIN_TIME,
  MAX_TIME,
  MAX_QUESTIONS,
  parseQuiz,
  parseQuestionBlocks,
  serializeQuiz,
  serializeQuestion,
  validateImageUrl,
};
