// T8 "quiz" — JiffyApp templates PRD T8, v1.0.0, $25. Branch-scored outcome quiz:
// fixed questions, a pure lookup-table `scoring` slot (never generated control flow,
// so outcomes can never drift nondeterministic), an outcome page, and an *optional*
// relay of the result.
//
// Relay-on-completion is brief-level config, not a slot: `brief.relayResult === true`
// makes the pipeline set `ctx.relay` (Task 19+) and require `notifyEmail`
// (`briefErrorsForTemplate` already encodes this). `render` includes the
// `send-result`/`success-msg` UI iff `ctx.relay` is non-null — but `elementContract`/
// `bindableTestids` take `slots` only (no `ctx`), so those two testids can NEVER be
// census/bindable in v1: rendering them when relay is on is "extra elements beyond
// the census", which is fine, but no golden may assert them (the relay-proof gate,
// not a Playwright assertion, covers the send path). This keeps the census/goldens
// identical whether or not a given delivered tool has relay turned on.
//
// All questions + all options exist in the DOM from load (each question section
// `hidden` except the first), so `click(option, nth)` addresses radio options
// *globally* in document order across every question — this is what makes scripted
// golden sequences deterministic without needing per-question testids.
//
// `scoreQuiz` is the one piece of real logic this template ships (like csv-
// dashboard's `computeAggregates`): a pure, exported, directly-unit-tested function
// whose *compiled source* is embedded into `/app.js` via `.toString()` (function-
// replacer marker injection, never plain-string `.replace` — see calculator.ts's
// header for why plain-string replace corrupts `$`-prefixed sequences).

import { briefErrorsForTemplate, MATCHER_KEYWORDS } from '../brief.js';
import type { FileSet, GoldenSet, JiffyBrief, SlotValues } from '../types.js';
import {
  esc,
  pageShell,
  SlotError,
  validateSlots,
  type RenderContext,
  type SlotSpec,
  type TemplateDefinition,
} from './engine.js';

export interface QuizQuestion {
  text: string;
  options: string[];
}

export interface QuizBracket {
  min: number;
  title: string;
  body: string;
}

export interface QuizScoring {
  optionPoints: number[][];
  brackets: QuizBracket[];
}

/**
 * Pure scoring lookup — sums `optionPoints[q][answers[q]]` across questions, then
 * picks the highest bracket whose `min <= score` (brackets are validated ascending,
 * first bracket's min === 0, so this always resolves to *some* bracket). Unit-tested
 * directly here AND embedded (via `.toString()`) into the rendered `/app.js`, so
 * there is exactly one implementation, never a hand-duplicated client copy.
 */
export function scoreQuiz(
  answers: number[],
  scoring: { optionPoints: number[][]; brackets: { min: number; title: string; body: string }[] },
): { title: string; body: string } {
  let score = 0;
  for (let i = 0; i < answers.length; i++) {
    const row = scoring.optionPoints[i];
    const idx = answers[i];
    if (row && typeof row[idx] === 'number') score += row[idx];
  }
  let chosen = scoring.brackets[0];
  for (const bracket of scoring.brackets) {
    if (bracket.min <= score) chosen = bracket;
  }
  return { title: chosen.title, body: chosen.body };
}

function validateQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return ['questions: must be an array'];
  const errors: string[] = [];
  if (value.length < 2 || value.length > 10) {
    errors.push('questions: must have 2-10 entries');
  }
  value.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      errors.push(`questions[${i}]: must be an object`);
      return;
    }
    const { text, options } = item as Record<string, unknown>;
    if (typeof text !== 'string' || text.trim().length === 0) {
      errors.push(`questions[${i}].text: required non-empty string`);
    }
    const validOptions =
      Array.isArray(options) &&
      options.length >= 2 &&
      options.length <= 5 &&
      options.every((o) => typeof o === 'string' && o.trim().length > 0);
    if (!validOptions) {
      errors.push(`questions[${i}].options: must be an array of 2-5 non-empty strings`);
    }
  });
  return errors;
}

function validateScoring(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['scoring: must be an object { optionPoints, brackets }'];
  }
  const errors: string[] = [];
  const { optionPoints, brackets } = value as Record<string, unknown>;

  const validOptionPoints =
    Array.isArray(optionPoints) &&
    optionPoints.length > 0 &&
    optionPoints.every(
      (row) => Array.isArray(row) && row.every((n) => typeof n === 'number' && Number.isFinite(n)),
    );
  if (!validOptionPoints) {
    errors.push('scoring.optionPoints: must be a non-empty array of number arrays');
  }

  if (!Array.isArray(brackets) || brackets.length === 0) {
    errors.push('scoring.brackets: must be a non-empty array');
  } else {
    let prevMin: number | undefined;
    brackets.forEach((b, i) => {
      if (typeof b !== 'object' || b === null) {
        errors.push(`scoring.brackets[${i}]: must be an object`);
        return;
      }
      const { min, title, body } = b as Record<string, unknown>;
      if (typeof min !== 'number' || !Number.isFinite(min)) {
        errors.push(`scoring.brackets[${i}].min: required finite number`);
      } else {
        if (i === 0 && min !== 0) {
          errors.push('scoring.brackets[0].min: first bracket must start at 0');
        }
        if (prevMin !== undefined && min <= prevMin) {
          errors.push(
            `scoring.brackets[${i}].min: must be strictly greater than the previous bracket's min`,
          );
        }
        prevMin = min;
      }
      if (typeof title !== 'string' || title.trim().length === 0) {
        errors.push(`scoring.brackets[${i}].title: required non-empty string`);
      }
      if (typeof body !== 'string' || body.trim().length === 0) {
        errors.push(`scoring.brackets[${i}].body: required non-empty string`);
      }
    });
  }

  return errors;
}

const SLOTS: SlotSpec[] = [
  {
    name: 'headline',
    kind: 'copy',
    required: true,
    description: 'Page headline / title, e.g. "Which Work Style Are You?".',
    example: 'Which Work Style Are You?',
  },
  {
    name: 'questions',
    kind: 'json',
    required: true,
    description:
      'Array of 2-10 questions, each `{ text: string; options: string[] }` with 2-5 options.',
    example: [
      { text: 'How do you start a new project?', options: ['Plan it out', 'Just dive in'] },
    ],
    validate: validateQuestions,
  },
  {
    name: 'scoring',
    kind: 'json',
    required: true,
    description:
      'Pure lookup table `{ optionPoints: number[][]; brackets: { min: number; title: string; ' +
      'body: string }[] }`. optionPoints[q][o] is the points awarded for question q, option o — ' +
      'dimensions must match questions/options exactly. brackets must be sorted ascending by ' +
      "`min`, with the first bracket's min === 0; the highest bracket with min <= total score " +
      'wins.',
    example: {
      optionPoints: [[0, 1]],
      brackets: [{ min: 0, title: 'The Improviser', body: 'You dive right in.' }],
    },
    validate: validateScoring,
  },
  {
    name: 'accentHex',
    kind: 'style',
    required: true,
    description: 'Brand accent color as a 6-digit hex code, e.g. #0F3D3E.',
    example: '#0F3D3E',
  },
];

function questionsFromSlots(slots: SlotValues): QuizQuestion[] {
  const value = slots.questions;
  return Array.isArray(value) ? (value as QuizQuestion[]) : [];
}

/**
 * Cross-slot validation: dimension agreement between `questions` and
 * `scoring.optionPoints` needs both slots together, which neither slot's own
 * `validate` can see. No-ops when either side already failed its own structural
 * validation (that failure is reported once, not duplicated here).
 */
function crossSlotErrors(slots: SlotValues): string[] {
  const questions = questionsFromSlots(slots);
  const scoring = slots.scoring as QuizScoring | undefined;
  if (questions.length === 0 || !scoring || !Array.isArray(scoring.optionPoints)) return [];

  const errors: string[] = [];
  if (scoring.optionPoints.length !== questions.length) {
    errors.push('scoring.optionPoints: length must match the number of questions');
    return errors;
  }
  questions.forEach((q, i) => {
    const row = scoring.optionPoints[i];
    if (!Array.isArray(q.options) || !Array.isArray(row) || row.length !== q.options.length) {
      errors.push(`scoring.optionPoints[${i}]: length must match questions[${i}].options length`);
    }
  });
  return errors;
}

const QUIZ_TESTIDS = [
  'question',
  'option',
  'quiz-next',
  'quiz-submit',
  'result',
  'result-detail',
  'retake',
  'footer',
];

function elementContract(_slots: SlotValues): string[] {
  return [...QUIZ_TESTIDS];
}

function bindableTestids(slots: SlotValues): { exact: string[]; prefixes: string[] } {
  return { exact: elementContract(slots), prefixes: [] };
}

function briefErrors(brief: JiffyBrief): string[] {
  return briefErrorsForTemplate('quiz', brief);
}

function buildStyles(accentHex: string): string {
  return `:root {
  --accent: ${accentHex};
  --text: #12181b;
  --muted: #45535a;
  --bg: #ffffff;
  --surface: #f4f6f5;
}
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: var(--text);
  background: var(--bg);
  line-height: 1.5;
}
.quiz { max-width: 640px; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
h1 { font-size: clamp(1.5rem, 3vw, 2.25rem); margin: 0 0 1.5rem; }
[data-testid="question"] h2 { font-size: 1.2rem; margin: 0 0 1rem; }
.options { display: grid; gap: 0.75rem; margin-bottom: 1.5rem; }
[data-testid="option"] {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  background: var(--surface);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  cursor: pointer;
}
.quiz-nav { margin-top: 1rem; }
button { font: inherit; font-weight: 600; padding: 0.7rem 1.4rem; border-radius: 0.5rem; border: none; cursor: pointer; }
button[data-testid="quiz-next"], button[data-testid="quiz-submit"] { background: var(--accent); color: #fff; }
button[data-testid="retake"], button[data-testid="send-result"] { background: transparent; color: var(--text); border: 1px solid #8a969b; margin-top: 0.75rem; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.quiz-result h2 { font-size: 1.5rem; margin: 0 0 0.5rem; }
[data-testid="success-msg"] { color: var(--muted); margin-top: 0.75rem; }
.jiffy-footer { text-align: center; padding: 2rem 1.5rem; color: var(--muted); font-size: 0.85rem; }
.jiffy-footer a { color: var(--muted); }
`;
}

const APP_JS_TEMPLATE = `'use strict';
const QUESTIONS = /*__QUESTIONS__*/;
const SCORING = /*__SCORING__*/;
const scoreQuiz = /*__SCORE_QUIZ_FN__*/;
const RELAY_URL = /*__RELAY_URL__*/;
const TEST_MODE = new URLSearchParams(location.search).has('jiffytest');

const sections = Array.from(document.querySelectorAll('[data-testid="question"]'));
const options = Array.from(document.querySelectorAll('[data-testid="option"]'));
const nextBtn = document.querySelector('[data-testid="quiz-next"]');
const submitBtn = document.querySelector('[data-testid="quiz-submit"]');
const resultPanel = document.getElementById('jiffy-quiz-result');
const resultEl = document.querySelector('[data-testid="result"]');
const resultDetailEl = document.querySelector('[data-testid="result-detail"]');
const retakeBtn = document.querySelector('[data-testid="retake"]');
const sendResultBtn = document.querySelector('[data-testid="send-result"]');
const successEl = document.querySelector('[data-testid="success-msg"]');
const form = document.getElementById('jiffy-quiz-form');

let current = 0;
const answers = new Array(QUESTIONS.length).fill(-1);

// Global option index -> { question index, option index } — options exist in the DOM
// for every question from load, so goldens can address them by a single document-order nth.
const optionOwners = [];
QUESTIONS.forEach((q, qi) => {
  q.options.forEach((_opt, oi) => optionOwners.push({ q: qi, o: oi }));
});

function isLastQuestion(i) {
  return i === QUESTIONS.length - 1;
}

function sumScore(ans) {
  let total = 0;
  for (let i = 0; i < ans.length; i++) {
    const row = SCORING.optionPoints[i];
    if (row && typeof row[ans[i]] === 'number') total += row[ans[i]];
  }
  return total;
}

function updateNav() {
  const answered = answers[current] !== -1;
  if (isLastQuestion(current)) {
    nextBtn.hidden = true;
    submitBtn.hidden = false;
    submitBtn.disabled = !answered;
  } else {
    nextBtn.hidden = false;
    submitBtn.hidden = true;
    nextBtn.disabled = !answered;
  }
}

options.forEach((label, i) => {
  const input = label.querySelector('input');
  input.addEventListener('change', () => {
    const owner = optionOwners[i];
    answers[owner.q] = owner.o;
    updateNav();
  });
});

nextBtn.addEventListener('click', () => {
  if (isLastQuestion(current) || answers[current] === -1) return;
  sections[current].hidden = true;
  current += 1;
  sections[current].hidden = false;
  updateNav();
});

form.addEventListener('submit', (e) => e.preventDefault());

submitBtn.addEventListener('click', () => {
  if (answers[current] === -1) return;
  const outcome = scoreQuiz(answers, SCORING);
  resultEl.textContent = outcome.title;
  resultDetailEl.textContent = outcome.body;
  resultPanel.hidden = false;
  if (successEl) successEl.hidden = true;
});

retakeBtn.addEventListener('click', () => {
  current = 0;
  for (let i = 0; i < answers.length; i++) answers[i] = -1;
  for (const input of form.querySelectorAll('input[type="radio"]')) input.checked = false;
  sections.forEach((s, i) => {
    s.hidden = i !== 0;
  });
  resultPanel.hidden = true;
  if (successEl) successEl.hidden = true;
  updateNav();
});

if (sendResultBtn) {
  sendResultBtn.addEventListener('click', () => {
    const outcome = scoreQuiz(answers, SCORING);
    fetch(RELAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fields: { result: outcome.title, score: String(sumScore(answers)) },
        kind: 'quiz-result',
        test: TEST_MODE,
      }),
    })
      .then((res) => {
        if (res.ok && successEl) successEl.hidden = false;
      })
      .catch(() => {});
  });
}

updateNav();
`;

function buildAppJs(
  questions: QuizQuestion[],
  scoring: QuizScoring,
  relayUrl: string | null,
): string {
  // Function replacers (not plain strings) — see calculator.ts header for why: injected
  // JSON/source can contain `$`-prefixed sequences that plain-string .replace would
  // otherwise misinterpret as its special `$&`/`$'`/`` $` ``/`$n` patterns.
  return APP_JS_TEMPLATE.replace('/*__QUESTIONS__*/', () => JSON.stringify(questions))
    .replace('/*__SCORING__*/', () => JSON.stringify(scoring))
    .replace('/*__SCORE_QUIZ_FN__*/', () => scoreQuiz.toString())
    .replace('/*__RELAY_URL__*/', () => JSON.stringify(relayUrl));
}

function renderQuestion(q: QuizQuestion, qIndex: number): string {
  const optionsHtml = q.options
    .map(
      (opt, oIndex) => `
        <label data-testid="option">
          <input type="radio" name="q${qIndex}" value="${oIndex}">
          <span>${esc(opt)}</span>
        </label>`,
    )
    .join('');
  const hiddenAttr = qIndex > 0 ? ' hidden' : '';
  return `
    <section data-testid="question"${hiddenAttr}>
      <h2>${esc(q.text)}</h2>
      <div class="options">${optionsHtml}
      </div>
    </section>`;
}

function render(slots: SlotValues, ctx: RenderContext): FileSet {
  const errors = [...validateSlots(QUIZ, slots), ...crossSlotErrors(slots)];
  if (errors.length > 0) throw new SlotError(errors);

  const headline = slots.headline as string;
  const questions = slots.questions as QuizQuestion[];
  const scoring = slots.scoring as QuizScoring;
  const accentHex = slots.accentHex as string;

  const questionsHtml = questions.map((q, i) => renderQuestion(q, i)).join('');

  const relayHtml = ctx.relay
    ? `
    <button type="button" data-testid="send-result">Send my result</button>
    <p data-testid="success-msg" hidden>Thanks — we sent your result.</p>`
    : '';

  const body = `<main class="quiz">
  <h1>${esc(headline)}</h1>
  <form id="jiffy-quiz-form" novalidate>${questionsHtml}
    <div class="quiz-nav">
      <button type="button" data-testid="quiz-next" disabled>Next</button>
      <button type="button" data-testid="quiz-submit" hidden disabled>See my result</button>
    </div>
  </form>
  <section class="quiz-result" id="jiffy-quiz-result" hidden>
    <h2 data-testid="result"></h2>
    <p data-testid="result-detail"></p>
    <button type="button" data-testid="retake">Retake quiz</button>${relayHtml}
  </section>
</main>
<script src="/app.js"></script>`;

  const html = pageShell({ title: headline, body, ctx });
  const css = buildStyles(accentHex);
  const relayUrl = ctx.relay
    ? `${ctx.publicBaseUrl}/relay/${ctx.relay.toolId}?t=${ctx.relay.token}`
    : null;
  const appJs = buildAppJs(questions, scoring, relayUrl);

  return {
    '/index.html': { content: html, contentType: 'text/html; charset=utf-8' },
    '/styles.css': { content: css, contentType: 'text/css; charset=utf-8' },
    '/app.js': { content: appJs, contentType: 'text/javascript; charset=utf-8' },
  };
}

const referenceBrief: JiffyBrief = {
  template: 'quiz',
  name: 'Work Style Quiz',
  description:
    'Two-question lead-magnet quiz that sorts visitors into "The Improviser" or "The Planner" ' +
    'based on how they approach new projects.',
  copy: { headline: 'Which Work Style Are You?' },
  brand: { accentHex: '#5b21b6' },
  relayResult: false,
};

const referenceSlots: SlotValues = {
  headline: 'Which Work Style Are You?',
  questions: [
    { text: 'How do you start a new project?', options: ['Plan it out first', 'Just dive in'] },
    { text: 'Your desk is usually...', options: ['Organized', 'A creative mess'] },
  ],
  scoring: {
    optionPoints: [
      [0, 1],
      [0, 2],
    ],
    brackets: [
      {
        min: 0,
        title: 'The Improviser',
        body: 'You thrive on spontaneity and figuring it out as you go.',
      },
      { min: 3, title: 'The Planner', body: 'You do your best work with a clear plan in hand.' },
    ],
  },
  accentHex: '#5b21b6',
};

const referenceGoldens: GoldenSet = {
  goldens: [
    {
      title: 'Low-point answers score The Improviser',
      steps: [
        { do: 'click', testid: 'option', nth: 0 },
        { do: 'click', testid: 'quiz-next' },
        { do: 'click', testid: 'option', nth: 2 },
        { do: 'click', testid: 'quiz-submit' },
      ],
      expect: [{ testid: 'result', equals: 'The Improviser' }],
    },
    {
      title: 'High-point answers score The Planner',
      steps: [
        { do: 'click', testid: 'option', nth: 1 },
        { do: 'click', testid: 'quiz-next' },
        { do: 'click', testid: 'option', nth: 3 },
        { do: 'click', testid: 'quiz-submit' },
      ],
      expect: [{ testid: 'result', equals: 'The Planner' }],
    },
    {
      title: 'Both questions render on load',
      steps: [],
      expect: [{ testid: 'question', count: 2 }],
    },
  ],
};

export const QUIZ: TemplateDefinition = {
  id: 'quiz',
  version: '1.0.0',
  priceUsd: 25,
  matcherKeywords: MATCHER_KEYWORDS.quiz,
  elementContract,
  bindableTestids,
  slots: SLOTS,
  briefErrors,
  render,
  goldenGuidance:
    'one golden per outcome bracket: scripted `click(option, nth)` per question (global ' +
    'document-order nth) + `click(quiz-next)` between questions, ending `click(quiz-submit)` ⇒ ' +
    '`equals(result, "<bracket title>")` — compute the expected title via `scoreQuiz` so it can ' +
    'never drift from the scoring table. One load-only golden asserting `count(question)`. ' +
    '`send-result`/`success-msg` are never golden-bindable (relay-on is a pipeline gate, not a ' +
    'Playwright assertion).',
  referenceBrief,
  referenceSlots,
  referenceGoldens,
};
