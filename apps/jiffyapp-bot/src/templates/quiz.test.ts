import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUIZ, scoreQuiz } from './quiz.js';
import { renderReference, REFERENCE_CTX } from './registry.js';
import { validateSlots } from './engine.js';

function refCtx() {
  return {
    slug: 's',
    toolUrl: 'https://s.jiffyapp.dev',
    publicBaseUrl: 'https://b.example',
    relay: null,
  };
}

test('quiz reference render carries every contract testid', () => {
  const { html } = renderReference(QUIZ);
  for (const tid of QUIZ.elementContract(QUIZ.referenceSlots)) {
    assert.match(html, new RegExp(`data-testid="${tid}"`), tid);
  }
});

test('quiz escapes buyer copy', () => {
  const slots = { ...QUIZ.referenceSlots, headline: '<script>alert(1)</script>' };
  const files = QUIZ.render(slots, refCtx());
  assert.equal(files['/index.html'].content.includes('<script>alert(1)'), false);
  assert.match(files['/index.html'].content, /&lt;script&gt;/);
});

test('quiz reference slots validate; missing required slot fails', () => {
  assert.deepEqual(validateSlots(QUIZ, QUIZ.referenceSlots), []);
  const { headline: _drop, ...rest } = QUIZ.referenceSlots as Record<string, unknown>;
  assert.ok(validateSlots(QUIZ, rest).length > 0);
});

test('quiz reference goldens bind only bindable testids (send-result/success-msg are never bindable)', () => {
  const { exact, prefixes } = QUIZ.bindableTestids(QUIZ.referenceSlots);
  assert.equal(exact.includes('send-result'), false);
  assert.equal(exact.includes('success-msg'), false);
  const ok = (tid: string) => exact.includes(tid) || prefixes.some((p) => tid.startsWith(p));
  for (const g of QUIZ.referenceGoldens.goldens) {
    for (const e of g.expect) {
      if ('testid' in e) assert.ok(ok(e.testid), e.testid);
    }
  }
});

test('reference golden set has 3 goldens with unique titles', () => {
  const titles = QUIZ.referenceGoldens.goldens.map((g) => g.title);
  assert.equal(titles.length, 3);
  assert.equal(new Set(titles).size, 3);
});

test('scoreQuiz picks the highest bracket whose min <= total score', () => {
  const scoring = QUIZ.referenceSlots.scoring as {
    optionPoints: number[][];
    brackets: { min: number; title: string; body: string }[];
  };
  assert.equal(scoreQuiz([0, 0], scoring).title, 'The Improviser'); // 0 + 0 = 0
  assert.equal(scoreQuiz([1, 1], scoring).title, 'The Planner'); // 1 + 2 = 3
  assert.equal(scoreQuiz([1, 0], scoring).title, 'The Improviser'); // 1 + 0 = 1 (< 3)
});

test('reference goldens compute their expected bracket titles via scoreQuiz (never hand-guessed)', () => {
  const scoring = QUIZ.referenceSlots.scoring as {
    optionPoints: number[][];
    brackets: { min: number; title: string; body: string }[];
  };
  // Golden 1: option nth 0 (q0->0) + option nth 2 (q1->0) => answers [0, 0]
  const g1Expected = scoreQuiz([0, 0], scoring).title;
  const g1 = QUIZ.referenceGoldens.goldens[0];
  const g1Assert = g1.expect.find((e) => 'testid' in e && e.testid === 'result') as {
    equals: string;
  };
  assert.equal(g1Assert.equals, g1Expected);

  // Golden 2: option nth 1 (q0->1) + option nth 3 (q1->1) => answers [1, 1]
  const g2Expected = scoreQuiz([1, 1], scoring).title;
  const g2 = QUIZ.referenceGoldens.goldens[1];
  const g2Assert = g2.expect.find((e) => 'testid' in e && e.testid === 'result') as {
    equals: string;
  };
  assert.equal(g2Assert.equals, g2Expected);
});

test('scoring dims validate: bracket ordering, first-bracket-min-0, and finite optionPoints', () => {
  const badFirstMin = {
    ...QUIZ.referenceSlots,
    scoring: {
      ...(QUIZ.referenceSlots.scoring as Record<string, unknown>),
      brackets: [{ min: 1, title: 'x', body: 'y' }],
    },
  };
  assert.ok(validateSlots(QUIZ, badFirstMin).length > 0);

  const notAscending = {
    ...QUIZ.referenceSlots,
    scoring: {
      optionPoints: (QUIZ.referenceSlots.scoring as { optionPoints: number[][] }).optionPoints,
      brackets: [
        { min: 0, title: 'a', body: 'b' },
        { min: 0, title: 'c', body: 'd' },
      ],
    },
  };
  assert.ok(validateSlots(QUIZ, notAscending).length > 0);

  const emptyBrackets = {
    ...QUIZ.referenceSlots,
    scoring: {
      optionPoints: (QUIZ.referenceSlots.scoring as { optionPoints: number[][] }).optionPoints,
      brackets: [],
    },
  };
  assert.ok(validateSlots(QUIZ, emptyBrackets).length > 0);
});

test('cross-slot validation rejects optionPoints dims that do not match questions/options', () => {
  const wrongRowCount = {
    ...QUIZ.referenceSlots,
    scoring: {
      optionPoints: [[0, 1]], // only 1 row for 2 questions
      brackets: (QUIZ.referenceSlots.scoring as { brackets: unknown }).brackets,
    },
  };
  assert.throws(() => QUIZ.render(wrongRowCount, refCtx()));

  const wrongOptionCount = {
    ...QUIZ.referenceSlots,
    scoring: {
      optionPoints: [
        [0, 1, 2], // 3 entries but question 0 has 2 options
        [0, 2],
      ],
      brackets: (QUIZ.referenceSlots.scoring as { brackets: unknown }).brackets,
    },
  };
  assert.throws(() => QUIZ.render(wrongOptionCount, refCtx()));
});

test('rejects questions outside the 2-10 / 2-5-options bounds', () => {
  const onlyQuestion = (
    QUIZ.referenceSlots.questions as Array<{ text: string; options: string[] }>
  )[0];
  const tooFewQuestions = { ...QUIZ.referenceSlots, questions: [onlyQuestion] };
  assert.ok(validateSlots(QUIZ, tooFewQuestions).length > 0);

  const tooFewOptions = {
    ...QUIZ.referenceSlots,
    questions: [
      { text: 'Q1', options: ['only one'] },
      { text: 'Q2', options: ['a', 'b'] },
    ],
  };
  assert.ok(validateSlots(QUIZ, tooFewOptions).length > 0);
});

test('render without relay ctx omits send-result/success-msg', () => {
  const files = QUIZ.render(QUIZ.referenceSlots, { ...refCtx(), relay: null });
  const html = files['/index.html'].content;
  assert.equal(html.includes('data-testid="send-result"'), false);
  assert.equal(html.includes('data-testid="success-msg"'), false);
});

test('render with relay ctx adds send-result/success-msg as extra (non-census) elements', () => {
  const files = QUIZ.render(QUIZ.referenceSlots, {
    ...REFERENCE_CTX,
    relay: { toolId: 'ref-tool', token: 'ref-token' },
  });
  const html = files['/index.html'].content;
  assert.match(html, /data-testid="send-result"/);
  assert.match(html, /data-testid="success-msg"/);
  // Still not part of the census/bindable surface even though they're rendered.
  assert.equal(QUIZ.elementContract(QUIZ.referenceSlots).includes('send-result'), false);
});

test('index.html loads app.js via a same-origin <script> tag', () => {
  const { html } = renderReference(QUIZ);
  assert.match(html, /<script src="\/app\.js">/);
});

test('rendered app.js embeds QUESTIONS/SCORING JSON and the scoreQuiz source with markers replaced', () => {
  const { files } = renderReference(QUIZ);
  const appJs = files['/app.js'].content;
  assert.equal(/\/\*__[A-Z_]+__\*\//.test(appJs), false, 'no leftover marker patterns');
  assert.equal(appJs.includes(JSON.stringify(QUIZ.referenceSlots.questions)), true);
  assert.equal(appJs.includes(JSON.stringify(QUIZ.referenceSlots.scoring)), true);
  assert.equal(appJs.includes(scoreQuiz.toString()), true);
});

test('all options exist in the DOM from load, addressable by a single global nth', () => {
  const { html } = renderReference(QUIZ);
  const matches = html.match(/data-testid="option"/g) ?? [];
  assert.equal(matches.length, 4); // 2 questions x 2 options
});

test('only the first question section is visible at load', () => {
  const { html } = renderReference(QUIZ);
  const sections = html.match(/<section data-testid="question"( hidden)?>/g) ?? [];
  assert.equal(sections.length, 2);
  assert.equal(sections[0], '<section data-testid="question">');
  assert.equal(sections[1], '<section data-testid="question" hidden>');
});

test('result/result-detail exist empty at load (census-safe)', () => {
  const { html } = renderReference(QUIZ);
  assert.match(html, /<h2 data-testid="result"><\/h2>/);
  assert.match(html, /<p data-testid="result-detail"><\/p>/);
});
