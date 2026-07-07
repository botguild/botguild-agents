import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBriefId,
  extractFencedJson,
  formatBriefErrors,
  parseAdBrief,
  parseReadabilityBrief,
  validateAdBrief,
} from './brief.js';

const validBrief = {
  brandVoiceGuide: 'markdown: warm, no jargon',
  offer: '20% off spring line',
  campaign: { campaignName: 'Q3-Launch-Test', objective: 'OUTCOME_TRAFFIC', adSetName: 'Prospecting-Broad-US' },
  creative: { landingUrl: 'https://example.com/offer', pageId: '1234567890', imageRef: 'hero.png' },
  platform: 'facebook-instagram-feed',
  variantCount: 10,
  angleCount: 3,
  policyConstraints: ['no weight-loss or body-transformation claims'],
};

const gigDescription = (brief: unknown): string =>
  `We need ad copy for our spring campaign.\n\n\`\`\`json\n${JSON.stringify(brief, null, 2)}\n\`\`\`\n\nThanks!`;

test('extractFencedJson finds a ```json fence and a bare ``` fence', () => {
  const tagged = extractFencedJson('before\n```json\n{"a": 1}\n```\nafter');
  assert.ok(tagged.ok && (tagged.value as { a: number }).a === 1);
  const bare = extractFencedJson('```\n{"b": 2}\n```');
  assert.ok(bare.ok && (bare.value as { b: number }).b === 2);
});

test('extractFencedJson reports missing fence and malformed JSON distinctly', () => {
  const missing = extractFencedJson('no code block here');
  assert.ok(!missing.ok && missing.error.includes('no fenced JSON block'));
  const malformed = extractFencedJson('```json\n{"a": 1,,}\n```');
  assert.ok(!malformed.ok && malformed.error.includes('not valid JSON'));
});

test('a complete brief parses from a gig description with defaults applied', () => {
  const result = parseAdBrief(gigDescription(validBrief));
  assert.ok(result.ok);
  assert.equal(result.brief.variantCount, 10);
  assert.equal(result.brief.campaign.campaignName, 'Q3-Launch-Test');
  assert.deepEqual(result.brief.policyConstraints, ['no weight-loss or body-transformation claims']);
});

test('variantCount/angleCount default when omitted', () => {
  const { variantCount: _v, angleCount: _a, ...rest } = validBrief;
  const result = parseAdBrief(gigDescription(rest));
  assert.ok(result.ok);
  assert.equal(result.brief.variantCount, 10);
  assert.equal(result.brief.angleCount, 3);
});

test('missing campaign/creative scaffolding is rejected with field-level errors', () => {
  const { campaign: _c, ...noCampaign } = validBrief;
  const result = validateAdBrief(noCampaign);
  assert.ok(!result.ok);
  assert.ok(result.errors.some((e) => e.field === 'campaign'));

  const badCreative = { ...validBrief, creative: { landingUrl: 'not-a-url', pageId: '1', imageRef: 'x' } };
  const creativeResult = validateAdBrief(badCreative);
  assert.ok(!creativeResult.ok);
  assert.ok(creativeResult.errors.some((e) => e.field === 'creative.landingUrl'));
});

test('angleCount below the contractual 3 (or above variantCount) is rejected', () => {
  const tooFew = validateAdBrief({ ...validBrief, angleCount: 2 });
  assert.ok(!tooFew.ok && tooFew.errors.some((e) => e.field === 'angleCount'));
  const tooMany = validateAdBrief({ ...validBrief, variantCount: 3, angleCount: 5 });
  assert.ok(!tooMany.ok && tooMany.errors.some((e) => e.field === 'angleCount'));
});

test('non-object brief and malformed field types are rejected', () => {
  const notObject = validateAdBrief('just a string');
  assert.ok(!notObject.ok && notObject.errors[0]?.field === '(root)');
  const badConstraints = validateAdBrief({ ...validBrief, policyConstraints: 'no claims' });
  assert.ok(!badConstraints.ok && badConstraints.errors.some((e) => e.field === 'policyConstraints'));
});

test('a description with no fence fails brief parsing (scorer skips it)', () => {
  const result = parseAdBrief('Write me some ads please, budget $15');
  assert.ok(!result.ok);
});

test('parseReadabilityBrief accepts { paragraph } and rejects everything else', () => {
  const ok = parseReadabilityBrief('```json\n{"paragraph": "Score this text."}\n```');
  assert.ok(ok.ok && ok.brief.paragraph === 'Score this text.');
  assert.equal(parseReadabilityBrief(gigDescription(validBrief)).ok, false);
  assert.equal(parseReadabilityBrief('```json\n{"paragraph": "   "}\n```').ok, false);
  assert.equal(parseReadabilityBrief('no fence').ok, false);
});

test('extractBriefId reads the fenced and bare forms', () => {
  const id = '0d0cf1f6-6f4b-4b8e-9dd0-3a55da5c8f4b';
  assert.equal(extractBriefId(`\`\`\`json\n{"briefId": "${id}"}\n\`\`\``), id);
  assert.equal(extractBriefId(`Monthly refresh please. briefId: ${id}`), id);
  assert.equal(extractBriefId('no id here'), undefined);
  // An ordinary ad brief without briefId is not a refresh gig.
  assert.equal(extractBriefId(gigDescription(validBrief)), undefined);
});

test('formatBriefErrors renders one line per field error', () => {
  const message = formatBriefErrors([
    { field: 'campaign.objective', message: 'required non-empty string' },
    { field: 'creative.landingUrl', message: 'must be an http(s) URL' },
  ]);
  assert.ok(message.includes('`campaign.objective`'));
  assert.ok(message.includes('`creative.landingUrl`'));
  assert.ok(message.includes('corrected fenced JSON brief'));
});
