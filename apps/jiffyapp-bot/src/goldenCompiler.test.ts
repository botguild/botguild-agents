import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import {
  createGoldenCompiler,
  proposalBindable,
  usageCostUsd,
  PER_TEMPLATE_DYNAMIC_PREFIXES,
} from './goldenCompiler.js';
import { CALCULATOR } from './templates/calculator.js';
import { HAIKU_PRICING_PER_MTOK } from './config.js';
import type { GoldenSet } from './types.js';

const silentLogger = pino({ level: 'silent' });

// ---- fetch stubbing: canned Anthropic messages-API responses ----

interface CapturedRequest {
  url: string;
  body: {
    model?: string;
    system?: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    messages?: Array<{ role: string; content: string }>;
    tool_choice?: { type: string; name: string };
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function toolUseResponse(input: unknown, usage = { input_tokens: 1000, output_tokens: 500 }) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'tool_use', id: 'tu_1', name: 'report_golden_examples', input }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage,
  };
}

/** Records every request body and replays canned responses in order (last one repeats). */
function stubFetch(responses: unknown[], captured: CapturedRequest[]): typeof fetch {
  let call = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as CapturedRequest['body']) : {};
    captured.push({ url: String(input), body });
    const response = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return jsonResponse(response);
  }) as typeof fetch;
}

const bindable = proposalBindable(CALCULATOR, CALCULATOR.referenceBrief);

// A golden set valid against CALCULATOR's proposal-time bindable surface (reuses the
// template's own referenceGoldens, which are already valid against the narrower
// def.bindableTestids(referenceSlots) surface — proposalBindable only widens it).
const VALID_SET: GoldenSet = CALCULATOR.referenceGoldens;

// References a testid outside the bindable surface entirely — never valid.
const INVALID_SET = {
  goldens: [
    { title: 'a', steps: [], expect: [{ testid: 'totally-off-contract', visible: true }] },
    { title: 'b', steps: [], expect: [{ titleEquals: 'X' }] },
    { title: 'c', steps: [], expect: [{ testid: 'result', visible: true }] },
  ],
};

test('valid golden set on the first attempt: ok true, exactly one fetch call', async () => {
  const captured: CapturedRequest[] = [];
  const compiler = createGoldenCompiler({
    apiKey: 'test-key',
    logger: silentLogger,
    fetchImpl: stubFetch([toolUseResponse(VALID_SET)], captured),
  });

  const result = await compiler.compile(CALCULATOR.referenceBrief, CALCULATOR, bindable);
  assert.equal(result.ok, true);
  assert.equal(captured.length, 1);
  if (result.ok) {
    assert.equal(result.set.goldens.length, VALID_SET.goldens.length);
  }
});

test('first attempt invalid, retry valid: 2 fetches, ok true', async () => {
  const captured: CapturedRequest[] = [];
  const compiler = createGoldenCompiler({
    apiKey: 'test-key',
    logger: silentLogger,
    fetchImpl: stubFetch([toolUseResponse(INVALID_SET), toolUseResponse(VALID_SET)], captured),
  });

  const result = await compiler.compile(CALCULATOR.referenceBrief, CALCULATOR, bindable);
  assert.equal(result.ok, true);
  assert.equal(captured.length, 2);

  // The retry's user message carries the first attempt's validation errors.
  const retryContent = captured[1]?.body.messages?.[0]?.content ?? '';
  assert.match(retryContent, /previous attempt failed validation/i);
  assert.match(retryContent, /not bindable/);
});

test('both attempts invalid: ok false with errors, 2 fetches', async () => {
  const captured: CapturedRequest[] = [];
  const compiler = createGoldenCompiler({
    apiKey: 'test-key',
    logger: silentLogger,
    fetchImpl: stubFetch([toolUseResponse(INVALID_SET), toolUseResponse(INVALID_SET)], captured),
  });

  const result = await compiler.compile(CALCULATOR.referenceBrief, CALCULATOR, bindable);
  assert.equal(result.ok, false);
  assert.equal(captured.length, 2);
  if (!result.ok) {
    assert.ok(result.errors.length > 0);
  }
});

test('costUsd accumulates real usage at pinned Haiku pricing', async () => {
  const captured: CapturedRequest[] = [];
  const compiler = createGoldenCompiler({
    apiKey: 'test-key',
    logger: silentLogger,
    fetchImpl: stubFetch(
      [toolUseResponse(VALID_SET, { input_tokens: 1000, output_tokens: 500 })],
      captured,
    ),
  });

  const result = await compiler.compile(CALCULATOR.referenceBrief, CALCULATOR, bindable);
  assert.equal(result.ok, true);
  // 1000/1e6 * $1.00 + 500/1e6 * $5.00 = 0.001 + 0.0025 = 0.0035
  assert.ok(Math.abs(result.costUsd - 0.0035) < 1e-9, `expected ~0.0035, got ${result.costUsd}`);
});

test('usageCostUsd matches pinned Haiku pricing directly', () => {
  assert.equal(
    usageCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }),
    HAIKU_PRICING_PER_MTOK.input,
  );
  assert.equal(
    usageCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }),
    HAIKU_PRICING_PER_MTOK.output,
  );
  const mixed = usageCostUsd({
    input_tokens: 2_000,
    output_tokens: 1_500,
    cache_creation_input_tokens: 4_000,
    cache_read_input_tokens: 10_000,
  });
  assert.ok(Math.abs(mixed - (0.002 + 0.0075 + 0.005 + 0.001)) < 1e-12);
});

test('system prompt carries an ephemeral cache_control breakpoint on every call', async () => {
  const captured: CapturedRequest[] = [];
  const compiler = createGoldenCompiler({
    apiKey: 'test-key',
    logger: silentLogger,
    fetchImpl: stubFetch([toolUseResponse(INVALID_SET), toolUseResponse(VALID_SET)], captured),
  });

  await compiler.compile(CALCULATOR.referenceBrief, CALCULATOR, bindable);
  assert.equal(captured.length, 2);
  for (const req of captured) {
    assert.deepEqual(req.body.system?.[0]?.cache_control, { type: 'ephemeral' });
  }
});

test('the forced tool_choice names report_golden_examples', async () => {
  const captured: CapturedRequest[] = [];
  const compiler = createGoldenCompiler({
    apiKey: 'test-key',
    logger: silentLogger,
    fetchImpl: stubFetch([toolUseResponse(VALID_SET)], captured),
  });
  await compiler.compile(CALCULATOR.referenceBrief, CALCULATOR, bindable);
  assert.deepEqual(captured[0]?.body.tool_choice, { type: 'tool', name: 'report_golden_examples' });
});

// ---- recompileForEdit (Task 22) ----

test('recompileForEdit: valid updated set on the first attempt, edit-update suffix in the system prompt', async () => {
  const captured: CapturedRequest[] = [];
  const compiler = createGoldenCompiler({
    apiKey: 'test-key',
    logger: silentLogger,
    fetchImpl: stubFetch([toolUseResponse(VALID_SET)], captured),
  });

  const result = await compiler.recompileForEdit({
    brief: CALCULATOR.referenceBrief,
    instruction: 'change the headline copy',
    currentGoldens: VALID_SET,
    def: CALCULATOR,
    bindable,
  });

  assert.equal(result.ok, true);
  assert.equal(captured.length, 1);
  // The forced tool + cached system prompt are unchanged, with the edit-update instruction appended.
  assert.deepEqual(captured[0]?.body.tool_choice, { type: 'tool', name: 'report_golden_examples' });
  assert.deepEqual(captured[0]?.body.system?.[0]?.cache_control, { type: 'ephemeral' });
  assert.match(captured[0]?.body.system?.[0]?.text ?? '', /UPDATING an existing golden set/i);
  assert.match(captured[0]?.body.messages?.[0]?.content ?? '', /change the headline copy/);
});

test('recompileForEdit: first attempt invalid, retry valid — 2 fetches, ok true', async () => {
  const captured: CapturedRequest[] = [];
  const compiler = createGoldenCompiler({
    apiKey: 'test-key',
    logger: silentLogger,
    fetchImpl: stubFetch([toolUseResponse(INVALID_SET), toolUseResponse(VALID_SET)], captured),
  });

  const result = await compiler.recompileForEdit({
    brief: CALCULATOR.referenceBrief,
    instruction: 'tweak a label',
    currentGoldens: VALID_SET,
    def: CALCULATOR,
    bindable,
  });

  assert.equal(result.ok, true);
  assert.equal(captured.length, 2);
  assert.match(
    captured[1]?.body.messages?.[0]?.content ?? '',
    /previous attempt failed validation/i,
  );
});

// ---- proposalBindable ----

test('proposalBindable(calculator) widens the reference surface with input- alongside breakdown-', () => {
  const surface = proposalBindable(CALCULATOR, CALCULATOR.referenceBrief);
  assert.ok(surface.prefixes.includes('input-'));
  assert.ok(surface.prefixes.includes('breakdown-')); // template's own interaction-created prefix
  // exact ids from the reference census are still present (widened, not replaced)
  assert.ok(surface.exact.includes('calc-submit'));
});

test('PER_TEMPLATE_DYNAMIC_PREFIXES has an entry for every template id', () => {
  for (const id of Object.keys(PER_TEMPLATE_DYNAMIC_PREFIXES)) {
    assert.ok(
      Array.isArray(
        PER_TEMPLATE_DYNAMIC_PREFIXES[id as keyof typeof PER_TEMPLATE_DYNAMIC_PREFIXES],
      ),
    );
  }
});
