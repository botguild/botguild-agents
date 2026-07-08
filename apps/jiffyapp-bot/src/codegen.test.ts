import { test } from 'node:test';
import assert from 'node:assert/strict';
import pino from 'pino';
import { createCodegen, buildCodegenPrompt, extractText, type AiLike } from './codegen.js';
import { CALCULATOR } from './templates/calculator.js';
import { CODEGEN_COST_PER_CALL_USD, CODEGEN_MODEL_ID, HAIKU_MODEL_ID } from './config.js';

const silentLogger = pino({ level: 'silent' });

// ---- fake Workers AI binding ----

interface AiCall {
  model: string;
}

/** Replays canned results in order — one entry per expected ai.run call. `{ throw }` entries
 *  reject instead of resolving, so a single queue exercises both success and error paths. */
function queueAi(...results: Array<unknown | { throw: Error }>): { ai: AiLike; calls: AiCall[] } {
  const calls: AiCall[] = [];
  let i = 0;
  const ai: AiLike = {
    async run(model) {
      calls.push({ model });
      const item = results[Math.min(i, results.length - 1)];
      i += 1;
      if (item && typeof item === 'object' && 'throw' in (item as Record<string, unknown>)) {
        throw (item as { throw: Error }).throw;
      }
      return item;
    },
  };
  return { ai, calls };
}

// ---- fake Anthropic (Haiku escalation) fetch ----

interface CapturedRequest {
  url: string;
  body: {
    model?: string;
    system?: Array<{ type: string; text: string; cache_control?: { type: string } }>;
    messages?: Array<{ role: string; content: string }>;
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(text: string, usage = { input_tokens: 1000, output_tokens: 500 }) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: HAIKU_MODEL_ID,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage,
  };
}

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

const failAi: AiLike = {
  run: async () => {
    throw new Error('escalate must never call Workers AI');
  },
};

// ---- generate(): Qwen (Workers AI) path ----

test('valid slots JSON from Workers AI: ok true, flat cost, Qwen model id', async () => {
  const { ai, calls } = queueAi({ response: JSON.stringify(CALCULATOR.referenceSlots) });
  const codegen = createCodegen({ ai, anthropicApiKey: 'k', logger: silentLogger });

  const result = await codegen.generate({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
  });

  assert.equal(result.ok, true);
  assert.equal(result.costUsd, CODEGEN_COST_PER_CALL_USD);
  assert.equal(result.model, CODEGEN_MODEL_ID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.model, CODEGEN_MODEL_ID);
  assert.deepEqual(result.slots, CALCULATOR.referenceSlots);
});

test('a function slot containing a deny-listed token fails slot validation (not a model error)', async () => {
  const badSlots = {
    ...CALCULATOR.referenceSlots,
    compute: "(inputs, config) => { fetch('https://evil.example'); return { total: '$0.00' }; }",
  };
  const { ai } = queueAi({ response: JSON.stringify(badSlots) });
  const codegen = createCodegen({ ai, anthropicApiKey: 'k', logger: silentLogger });

  const result = await codegen.generate({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors?.some((e) => e.includes('compute') && e.includes('fetch')));
  assert.equal(result.costUsd, CODEGEN_COST_PER_CALL_USD);
  assert.equal(result.model, CODEGEN_MODEL_ID);
});

test('a json-kind slot delivered as a JSON string is normalized to an object', async () => {
  const slotsWithStringConfig = {
    ...CALCULATOR.referenceSlots,
    config: JSON.stringify(CALCULATOR.referenceSlots.config),
  };
  const { ai } = queueAi({ response: JSON.stringify(slotsWithStringConfig) });
  const codegen = createCodegen({ ai, anthropicApiKey: 'k', logger: silentLogger });

  const result = await codegen.generate({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.slots?.config, CALCULATOR.referenceSlots.config);
});

test('ai.run throws with no fallback configured: ok:false with a model-error message, never throws', async () => {
  const { ai, calls } = queueAi({ throw: new Error('workers ai boom') });
  const codegen = createCodegen({ ai, anthropicApiKey: 'k', logger: silentLogger });

  const result = await codegen.generate({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors?.[0] ?? '', /^model error: .*workers ai boom/);
  assert.equal(calls.length, 1);
  assert.equal(result.model, CODEGEN_MODEL_ID);
  assert.equal(result.costUsd, CODEGEN_COST_PER_CALL_USD);
});

test('primary returns unparseable/empty JSON with no fallback configured: ok:false, never throws', async () => {
  const { ai } = queueAi({ response: 'I refuse to answer.' });
  const codegen = createCodegen({ ai, anthropicApiKey: 'k', logger: silentLogger });

  const result = await codegen.generate({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors?.[0] ?? '', /^model error:/);
});

test('fallback configured + primary returns empty text: second ai.run call uses the fallback id', async () => {
  const { ai, calls } = queueAi(
    { response: '   ' },
    { response: JSON.stringify(CALCULATOR.referenceSlots) },
  );
  const codegen = createCodegen({
    ai,
    anthropicApiKey: 'k',
    logger: silentLogger,
    fallbackModelId: 'fallback-model-id',
  });

  const result = await codegen.generate({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.model, CODEGEN_MODEL_ID);
  assert.equal(calls[1]?.model, 'fallback-model-id');
  assert.equal(result.ok, true);
  assert.equal(result.model, 'fallback-model-id');
  assert.equal(result.costUsd, CODEGEN_COST_PER_CALL_USD * 2);
});

test('fallback configured + primary throws: fallback is used and its result wins', async () => {
  const { ai, calls } = queueAi(
    { throw: new Error('primary down') },
    { response: JSON.stringify(CALCULATOR.referenceSlots) },
  );
  const codegen = createCodegen({
    ai,
    anthropicApiKey: 'k',
    logger: silentLogger,
    fallbackModelId: 'fallback-model-id',
  });

  const result = await codegen.generate({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.model, 'fallback-model-id');
  assert.equal(result.ok, true);
  assert.equal(result.model, 'fallback-model-id');
});

test('fallback configured but both primary and fallback fail: ok:false, no throw', async () => {
  const { ai, calls } = queueAi(
    { throw: new Error('primary down') },
    { throw: new Error('fallback down too') },
  );
  const codegen = createCodegen({
    ai,
    anthropicApiKey: 'k',
    logger: silentLogger,
    fallbackModelId: 'fallback-model-id',
  });

  const result = await codegen.generate({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors?.[0] ?? '', /^model error:/);
  assert.equal(calls.length, 2);
  assert.equal(result.model, 'fallback-model-id');
  assert.equal(result.costUsd, CODEGEN_COST_PER_CALL_USD * 2);
});

// ---- generate(): Haiku escalation path ----

test('escalate:true routes to Anthropic (Haiku) with a cached system prompt and usage-based cost', async () => {
  const captured: CapturedRequest[] = [];
  const fetchImpl = stubFetch([textResponse(JSON.stringify(CALCULATOR.referenceSlots))], captured);
  const codegen = createCodegen({
    ai: failAi,
    anthropicApiKey: 'k',
    logger: silentLogger,
    fetchImpl,
  });

  const result = await codegen.generate({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
    escalate: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.model, HAIKU_MODEL_ID);
  assert.equal(captured.length, 1);
  assert.match(captured[0]?.url ?? '', /\/v1\/messages/);
  assert.deepEqual(captured[0]?.body.system?.[0]?.cache_control, { type: 'ephemeral' });
  // 1000/1e6 * $1.00 + 500/1e6 * $5.00 = 0.001 + 0.0025 = 0.0035
  assert.ok(Math.abs(result.costUsd - 0.0035) < 1e-9, `expected ~0.0035, got ${result.costUsd}`);
});

test('escalate:true with a model error: ok:false, never throws', async () => {
  // 400 (not 5xx/429) so the Anthropic SDK's built-in retry logic doesn't slow the test down.
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'boom' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  const codegen = createCodegen({
    ai: failAi,
    anthropicApiKey: 'k',
    logger: silentLogger,
    fetchImpl,
  });

  const result = await codegen.generate({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
    escalate: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.model, HAIKU_MODEL_ID);
  assert.match(result.errors?.[0] ?? '', /^model error:/);
});

// ---- buildCodegenPrompt ----

test('buildCodegenPrompt: system carries the slot table, hard rules, and golden examples', () => {
  const prompt = buildCodegenPrompt({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
  });

  assert.match(prompt.system, /compute/); // slot table lists every slot name
  assert.match(prompt.system, /Respond with ONLY a JSON object/);
  assert.match(prompt.system, /PURE functions/);
  assert.match(prompt.system, /generated values MUST make every golden pass exactly/);
  assert.ok(prompt.system.includes(JSON.stringify(CALCULATOR.referenceGoldens.goldens[0]?.title)));
});

test('buildCodegenPrompt: round-0 user message carries only the brief', () => {
  const prompt = buildCodegenPrompt({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
  });

  assert.ok(prompt.user.includes(JSON.stringify(CALCULATOR.referenceBrief.name)));
  assert.doesNotMatch(prompt.user, /Prior slots/);
  assert.doesNotMatch(prompt.user, /EDIT INSTRUCTION/);
});

test('buildCodegenPrompt: repair round includes prior slots and failures with the fix-only instruction', () => {
  const prompt = buildCodegenPrompt({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
    priorSlots: CALCULATOR.referenceSlots,
    failures: ['compute: must not contain "fetch"'],
  });

  assert.match(prompt.user, /Prior slots/);
  assert.ok(prompt.user.includes(JSON.stringify(CALCULATOR.referenceSlots.headline)));
  assert.match(prompt.user, /compute: must not contain "fetch"/);
  assert.match(prompt.user, /change only what is needed to fix these failures/);
});

test('buildCodegenPrompt: instruction threads into the user message', () => {
  const prompt = buildCodegenPrompt({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
    instruction: 'Change the accent color to blue.',
  });

  assert.match(
    prompt.user,
    /EDIT INSTRUCTION \(change only what this requires\): Change the accent color to blue\./,
  );
});

test('buildCodegenPrompt: instruction and repair feedback can both be present (edit-job repair round)', () => {
  const prompt = buildCodegenPrompt({
    def: CALCULATOR,
    brief: CALCULATOR.referenceBrief,
    goldens: CALCULATOR.referenceGoldens,
    priorSlots: CALCULATOR.referenceSlots,
    failures: ['accentHex: must be a 6-digit hex color (e.g. #a1b2c3)'],
    instruction: 'Change the accent color to blue.',
  });

  assert.match(prompt.user, /EDIT INSTRUCTION/);
  assert.match(prompt.user, /Prior slots/);
  assert.match(prompt.user, /accentHex: must be a 6-digit hex color/);
});

// ---- extractText ----

test('extractText tolerates every Workers AI response shape and falls back to "" for garbage', () => {
  assert.equal(extractText({ response: 'hello' }), 'hello');
  assert.equal(extractText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
  assert.equal(extractText('bare string'), 'bare string');
  assert.equal(extractText({ garbage: true }), '');
  assert.equal(extractText(null), '');
  assert.equal(extractText(undefined), '');
  assert.equal(extractText({ choices: [] }), '');
  assert.equal(extractText({ choices: [{ message: {} }] }), '');
});
