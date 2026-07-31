import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLatinScript } from '../brief.js';
import { OCR_SIMILARITY_THRESHOLD } from '../config.js';
import { normalizeForMatch, similarity } from '../gates/index.js';
import { renderSvgToPng } from '../pack/render.js';
import { nodeWasmSources } from '../pack/wasm.node.js';
import type { Generator } from '../generate.js';
import type { OcrGate } from '../gates/index.js';
import type { StyleAxis } from '../types.js';
import {
  GOLDEN_NAMES,
  buildMismatchName,
  runCalibration,
  summarize,
  type CalibrationImageResult,
  type CalibrationRun,
} from './harness.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const okRun = (score: number): CalibrationRun => ({ status: 'ok', score });
const unavailableRun = (): CalibrationRun => ({ status: 'unavailable' });

/** A minimal, explicit CalibrationImageResult for summarize()-level tests. */
function result(opts: {
  name: string;
  axisId?: string;
  vendor?: string;
  phash?: string | null;
  goodScores?: number[];
  badScores?: number[];
}): CalibrationImageResult {
  return {
    name: opts.name,
    axisId: opts.axisId ?? 'wordmark',
    vendor: opts.vendor ?? 'ideogram',
    phash: opts.phash ?? null,
    knownGood: { targetName: opts.name, runs: (opts.goodScores ?? [0.95]).map(okRun) },
    knownBad: { targetName: `${opts.name}-mismatch`, runs: (opts.badScores ?? [0.1]).map(okRun) },
  };
}

function gradientSvg(from: string, to: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<defs><radialGradient id="g" cx="50%" cy="50%" r="65%">' +
    `<stop offset="0%" stop-color="${from}"/>` +
    `<stop offset="100%" stop-color="${to}"/>` +
    '</radialGradient></defs>' +
    '<rect width="64" height="64" fill="url(#g)"/></svg>'
  );
}

async function renderGradientPng(from: string, to: string): Promise<Uint8Array> {
  return renderSvgToPng(gradientSvg(from, to), 1024, nodeWasmSources());
}

// ---------------------------------------------------------------------------
// GOLDEN_NAMES — assert fixture preconditions inline rather than assuming them
// ---------------------------------------------------------------------------

describe('GOLDEN_NAMES', () => {
  it('has at least 30 distinct names', () => {
    const distinct = new Set(GOLDEN_NAMES.map((g) => g.name));
    assert.ok(GOLDEN_NAMES.length >= 30, `expected >= 30 entries, got ${GOLDEN_NAMES.length}`);
    assert.equal(distinct.size, GOLDEN_NAMES.length, 'golden names must be pairwise distinct');
  });

  it('spans the required hard-case categories — measured against the actual fixture, not assumed', () => {
    const names = GOLDEN_NAMES.map((g) => g.name);
    assert.ok(
      names.some((n) => n.includes('&')),
      'expected at least one ampersand case',
    );
    assert.ok(
      names.some((n) => n.includes('-')),
      'expected at least one hyphenated case',
    );
    assert.ok(
      names.some((n) => /\p{M}/u.test(n.normalize('NFD'))),
      'expected at least one diacritic case',
    );
    assert.ok(
      names.some((n) => /(.)\1/i.test(n.replace(/\s/g, ''))),
      'expected at least one repeated-letter case',
    );
    assert.ok(
      names.some((n) => /\b[A-Z]{2,}\b/.test(n)),
      'expected at least one all-caps case',
    );
    assert.ok(
      names.some((n) => [...n.replace(/\s/g, '')].length === 1),
      'expected at least one single-character case',
    );
  });

  it("is Latin-script only, matching this bot's own intake rule (brief.ts's isLatinScript) — buildMismatchName's <0.5 similarity guarantee is only proven for Latin-script names (see its own comment), so the fixture must not silently drift outside that", () => {
    for (const { name } of GOLDEN_NAMES) {
      assert.ok(isLatinScript(name), `"${name}" is not Latin-script`);
    }
  });
});

// ---------------------------------------------------------------------------
// buildMismatchName
// ---------------------------------------------------------------------------

describe('buildMismatchName', () => {
  it('produces a target with similarity well below the OCR threshold for every golden name (measured, not assumed)', () => {
    for (const { name } of GOLDEN_NAMES) {
      const mismatch = buildMismatchName(name);
      const score = similarity(normalizeForMatch(name), normalizeForMatch(mismatch));
      assert.ok(score < 0.5, `expected similarity("${name}", "${mismatch}") < 0.5, got ${score}`);
    }
  });

  it('never coincides with the original for known adversarial short inputs (regression: an earlier atbash+reversal design collided on inputs like "az")', () => {
    // "az"/"za" and "mn"/"nm" are exactly the atbash-pair inputs that made an
    // earlier draft of buildMismatchName reconstruct the original string:
    // atbash("az") = "za", and reversing "za" gives back "az" exactly.
    for (const name of ['az', 'za', 'mn', 'nm', 'x', 'ax', 'xa', 'q']) {
      const mismatch = buildMismatchName(name);
      assert.notEqual(
        normalizeForMatch(mismatch),
        normalizeForMatch(name),
        `collided on "${name}"`,
      );
      const score = similarity(normalizeForMatch(name), normalizeForMatch(mismatch));
      assert.ok(score < 0.5, `expected < 0.5 for "${name}", got ${score} (mismatch="${mismatch}")`);
    }
  });

  it('stays low for single-character and repeated-letter names, where a naive scramble has nothing to reorder', () => {
    for (const name of ['X', 'Q', 'Ooo', 'Zzz', 'Fizz']) {
      const mismatch = buildMismatchName(name);
      const score = similarity(normalizeForMatch(name), normalizeForMatch(mismatch));
      assert.ok(score < 0.5, `expected < 0.5 for "${name}", got ${score}`);
    }
  });

  it('guarantees only a raw edit-distance floor of 14 for non-Latin input, NOT the <0.5 ratio (review finding: shiftChar is a no-op outside a-z/0-9)', () => {
    // A 20-character Cyrillic name: shiftChar leaves every character
    // unchanged (outside a-z/0-9), so only the 14-character marker
    // diverges. Measured: similarity = 0.588, ABOVE this module's own 0.5
    // bar — proving the <0.5 guarantee genuinely does NOT extend to
    // non-Latin input, exactly as the corrected comment on MISMATCH_MARKER
    // now states. GOLDEN_NAMES is guarded elsewhere (see the GOLDEN_NAMES
    // Latin-script test) so this case can never reach the shipped fixture.
    const cyrillic = 'прекраснаямаркаа'; // 16 chars; pad to ~20 for the measurement below
    const name = cyrillic + cyrillic.slice(0, 4); // 20 characters
    assert.equal([...name].length, 20, 'fixture precondition: exactly 20 characters');
    const mismatch = buildMismatchName(name);
    const normalizedName = normalizeForMatch(name);
    const normalizedMismatch = normalizeForMatch(mismatch);
    // The raw floor DOES still hold: mismatch is exactly 14 characters
    // longer, and Levenshtein distance is always >= the length difference.
    assert.equal([...normalizedMismatch].length - [...normalizedName].length, 14);
    const score = similarity(normalizedName, normalizedMismatch);
    assert.ok(
      score > 0.5,
      `expected the <0.5 bar to genuinely NOT hold for non-Latin input (got ${score}) — ` +
        'if this ever fails, the comment on MISMATCH_MARKER needs re-measuring, not the code',
    );
  });
});

// ---------------------------------------------------------------------------
// summarize — the testable core
// ---------------------------------------------------------------------------

describe('summarize', () => {
  it('computes the garbled-detection rate and the stylized pass rate independently', () => {
    const results = [
      result({ name: 'Alpha', goodScores: [0.97], badScores: [0.05] }), // good passes; bad correctly rejected
      result({ name: 'Beta', goodScores: [0.9], badScores: [0.1] }), // good passes; bad correctly rejected
      result({ name: 'Gamma', goodScores: [0.5], badScores: [0.2] }), // good FAILS (stylized-but-legible pass rate hit); bad correctly rejected
      result({ name: 'Delta', goodScores: [0.96], badScores: [0.9] }), // good passes; bad is a FALSE ACCEPT (scores above threshold)
    ];
    const summary = summarize(results);
    assert.equal(summary.stylizedPassRate, 3 / 4);
    assert.equal(summary.stylizedConsidered, 4);
    assert.equal(summary.garbledDetectionRate, 3 / 4);
    assert.equal(summary.garbledConsidered, 4);
  });

  it('flags an image as unstable when repeat runs straddle the threshold, even though the mean looks fine — instability is the §13 drift risk, not the mean', () => {
    const steady = result({ name: 'Steady', goodScores: [0.95, 0.96, 0.94, 0.95, 0.96] });
    const wobbly = result({ name: 'Wobbly', goodScores: [0.9, 0.9, 0.8, 0.9, 0.9] });

    // Prove the fixture precondition inline: the MEAN alone would call Wobbly
    // fine (>= threshold) — if this assertion ever failed, the test below
    // would no longer be proving what its name claims.
    const wobblyMean = (0.9 + 0.9 + 0.8 + 0.9 + 0.9) / 5;
    assert.ok(
      wobblyMean >= OCR_SIMILARITY_THRESHOLD,
      'fixture precondition: mean must look acceptable',
    );

    const summary = summarize([steady, wobbly]);
    assert.ok(
      summary.unstableChecks.some((c) => c.name === 'Wobbly' && c.label === 'known-good'),
      'Wobbly should be flagged unstable',
    );
    assert.equal(
      summary.unstableChecks.some((c) => c.name === 'Steady'),
      false,
      'Steady must not be flagged — all five runs land on the same side of the threshold',
    );
  });

  it("reports per-image score variance across repeat runs, on the real returned summary (regression: this test used to discard summarize()'s return value entirely)", () => {
    const flat = result({ name: 'Flat', goodScores: [0.95, 0.95, 0.95] });
    const noisy = result({ name: 'Noisy', goodScores: [0.9, 0.99, 0.87] });
    const summary = summarize([flat, noisy]);

    const flatCheck = summary.checks.find((c) => c.name === 'Flat' && c.label === 'known-good');
    const noisyCheck = summary.checks.find((c) => c.name === 'Noisy' && c.label === 'known-good');
    assert.ok(flatCheck, 'expected a checks entry for Flat/known-good');
    assert.ok(noisyCheck, 'expected a checks entry for Noisy/known-good');

    // Not exact equality: three identical 0.95 values still leave a few
    // ULPs of floating-point noise from the mean-subtraction (measured:
    // ~1.2e-32), not a real bug.
    assert.ok(
      flatCheck!.variance !== null && flatCheck!.variance < 1e-9,
      `three identical scores should have ~zero population variance, got ${flatCheck!.variance}`,
    );

    const mean = (0.9 + 0.99 + 0.87) / 3;
    const expectedNoisyVariance =
      [0.9, 0.99, 0.87].reduce((sum, v) => sum + (v - mean) ** 2, 0) / 3;
    assert.ok(
      expectedNoisyVariance > 0,
      'fixture precondition: noisy scores must have nonzero variance',
    );
    assert.equal(
      noisyCheck!.variance,
      expectedNoisyVariance,
      "must match statsFor's own population-variance computation exactly, not merely be truthy",
    );

    // PROVED BY MUTATION (performed manually against this exact test, not
    // shipped as a permanent mutant): hardcoding statsFor's `variance` to a
    // constant `0`, or deleting the `popVariance` call entirely, makes this
    // assertion fail (0 !== expectedNoisyVariance ~= 0.00246...) — see the
    // task report for the transcript. Reverting restores green.
  });

  it('reports the pHash distribution as min/median/p10 across all pairs (hand-verified fixture)', () => {
    // Pairwise Hamming distances are computed WITHIN each name's axis images
    // (mirroring checkDistinctness, which only ever compares concepts from
    // one job): A contributes 1 pair (distance 4), B contributes 1 pair
    // (distance 8), C contributes 3 pairs (distances 64, 2, 62).
    // Combined + sorted: [2, 4, 8, 62, 64] -> min=2, p10=2, median=8.
    const results = [
      result({ name: 'A', axisId: 'wordmark', phash: '0000000000000000' }),
      result({ name: 'A', axisId: 'lockup', phash: '000000000000000f' }),
      result({ name: 'B', axisId: 'wordmark', phash: '0000000000000000' }),
      result({ name: 'B', axisId: 'lockup', phash: '00000000000000ff' }),
      result({ name: 'C', axisId: 'wordmark', phash: '0000000000000000' }),
      result({ name: 'C', axisId: 'lockup', phash: 'ffffffffffffffff' }),
      result({ name: 'C', axisId: 'emblem', phash: '0000000000000003' }),
    ];
    const summary = summarize(results);
    assert.ok(summary.phash, 'expected a phash summary');
    assert.equal(summary.phash!.pairCount, 5);
    assert.equal(summary.phash!.min, 2);
    assert.equal(summary.phash!.median, 8);
    assert.equal(summary.phash!.p10, 2);
  });

  it('reports phash as null when fewer than two images share a golden name', () => {
    const summary = summarize([result({ name: 'Solo', phash: '0000000000000000' })]);
    assert.equal(summary.phash, null);
  });

  it('reports regeneration burn per axis from the known-good check, weighted by distinct name', () => {
    const results = [
      result({ name: 'A', axisId: 'wordmark', goodScores: [0.95] }), // pass
      result({ name: 'B', axisId: 'wordmark', goodScores: [0.4] }), // fail
      result({ name: 'C', axisId: 'emblem', goodScores: [0.4] }), // fail
      result({ name: 'D', axisId: 'emblem', goodScores: [0.4] }), // fail
    ];
    const summary = summarize(results);
    assert.equal(summary.regenBurnByAxis.wordmark?.considered, 2);
    assert.equal(summary.regenBurnByAxis.wordmark?.failRate, 0.5);
    assert.equal(summary.regenBurnByAxis.emblem?.considered, 2);
    assert.equal(summary.regenBurnByAxis.emblem?.failRate, 1);
  });

  it('excludes unavailable runs from every rate — never counts them as a pass or a fail', () => {
    const mixed: CalibrationImageResult = {
      name: 'Mixed',
      axisId: 'wordmark',
      vendor: 'ideogram',
      phash: null,
      knownGood: {
        targetName: 'Mixed',
        runs: [okRun(0.97), unavailableRun(), okRun(0.96), unavailableRun(), okRun(0.98)],
      },
      knownBad: {
        targetName: 'Mixed-mismatch',
        runs: [unavailableRun(), unavailableRun(), unavailableRun()],
      },
    };
    const summary = summarize([mixed]);
    // known-good: 3 of 5 runs usable, all >= threshold.
    assert.equal(summary.stylizedConsidered, 1);
    assert.equal(summary.stylizedPassRate, 1);
    // known-bad: 0 of 3 runs usable -> excluded entirely, not counted either way.
    assert.equal(summary.garbledConsidered, 0);
    assert.equal(summary.garbledDetectionRate, null);
    assert.ok(
      summary.blockers.some((b) => /unavailable/i.test(b)),
      'an all-unavailable check must block freezing rather than silently vanish',
    );
    assert.equal(summary.canFreeze, false);
  });

  it('refuses to recommend freezing when the golden set has fewer than the required minimum', () => {
    const results = [result({ name: 'OnlyOne', goodScores: [0.99], badScores: [0.01] })];
    const summary = summarize(results); // default minGoldenNames = 30
    assert.equal(summary.goldenCount, 1);
    assert.equal(summary.canFreeze, false);
    assert.ok(summary.blockers.some((b) => /30/.test(b)));
  });

  it('refuses to recommend freezing when any image is unstable, even with enough names and otherwise-clean rates', () => {
    const results = Array.from({ length: 30 }, (_, i) =>
      result({ name: `Name${i}`, goodScores: [0.95, 0.96, 0.94], badScores: [0.05, 0.04, 0.06] }),
    );
    results.push(result({ name: 'Wobbly', goodScores: [0.9, 0.8], badScores: [0.05, 0.04] }));
    const summary = summarize(results);
    assert.equal(summary.goldenCount, 31);
    assert.equal(summary.canFreeze, false);
    assert.ok(summary.blockers.some((b) => /unstable/i.test(b)));
  });

  it('recommends freezing once >=30 distinct names are present, nothing is unstable, rates are healthy, AND pHash separation clears the threshold', () => {
    // Three well-separated 64-bit hashes reused across every name: pairwise
    // distinctness is assessed WITHIN one name's own axis images
    // (buildPhashSummary groups by name), so reusing the same three hex
    // values across different names is fine — only within-name comparisons
    // are ever computed.
    const HASH_A = '0000000000000000';
    const HASH_B = 'ffff000000000000'; // distance 16 from A
    const HASH_C = '00000000ffff0000'; // distance 16 from A, distance 32 from B
    const results: CalibrationImageResult[] = [];
    for (let i = 0; i < 30; i++) {
      const name = `Name${i}`;
      const goodScores = [0.95, 0.96, 0.94];
      const badScores = [0.05, 0.06, 0.04];
      results.push(result({ name, axisId: 'wordmark', phash: HASH_A, goodScores, badScores }));
      results.push(result({ name, axisId: 'lockup', phash: HASH_B, goodScores, badScores }));
      results.push(result({ name, axisId: 'emblem', phash: HASH_C, goodScores, badScores }));
    }
    const summary = summarize(results);
    assert.equal(
      summary.phash!.min,
      16,
      'fixture precondition: the closest pair in any one name is 16 apart',
    );
    assert.equal(summary.canFreeze, true);
    assert.deepEqual(summary.blockers, []);
  });

  it('reports a badly-calibrated threshold as such — the harness must be able to say a threshold is WRONG, not merely confirm whatever it is given', () => {
    // Every known-bad check scores ABOVE the default threshold: the gate
    // would accept obviously mismatched lettering. A harness that only ever
    // confirmed the current constant would not surface this.
    const results = Array.from({ length: 30 }, (_, i) =>
      result({ name: `Name${i}`, goodScores: [0.95, 0.95], badScores: [0.9, 0.9] }),
    );
    const summary = summarize(results);
    assert.equal(
      summary.garbledDetectionRate,
      0,
      'every known-bad check scores above threshold: zero detected',
    );
    assert.equal(summary.canFreeze, false);
    assert.ok(summary.blockers.some((b) => /garbled-detection rate/i.test(b)));

    // Re-evaluating the SAME captured evidence against a stricter candidate
    // threshold (no new vendor calls needed) shows the real trade-off: the
    // stricter cutoff now correctly rejects every known-bad check, but ALSO
    // now rejects every known-good one, because this fixture deliberately
    // set the good/bad scores close together (0.95 vs 0.9).
    const stricter = summarize(results, { ocrThreshold: 0.99 });
    assert.equal(stricter.garbledDetectionRate, 1);
    assert.equal(stricter.stylizedPassRate, 0);
    assert.equal(stricter.canFreeze, false);
  });

  it('handles an empty result set without throwing', () => {
    const summary = summarize([]);
    assert.equal(summary.goldenCount, 0);
    assert.equal(summary.garbledDetectionRate, null);
    assert.equal(summary.stylizedPassRate, null);
    assert.equal(summary.phash, null);
    assert.equal(summary.canFreeze, false);
  });

  // -------------------------------------------------------------------------
  // Review round 1 — C1 through C5, each reproduced with a concrete dataset
  // and asserted `canFreeze: false` with a named blocker.
  // -------------------------------------------------------------------------

  describe('C1 — canFreeze must consult the pHash threshold, not just OCR', () => {
    it('refuses to recommend freezing when no pairwise pHash data exists at all, even with perfect OCR health and enough names', () => {
      // 30 names, ONE image each — no second axis image for any name, so no
      // pair can ever be formed anywhere in the dataset.
      const results = Array.from({ length: 30 }, (_, i) =>
        result({ name: `Name${i}`, goodScores: [0.95, 0.96, 0.94], badScores: [0.05, 0.06, 0.04] }),
      );
      const summary = summarize(results);
      assert.equal(summary.phash, null, 'fixture precondition: no name has a second axis image');
      assert.equal(summary.canFreeze, false);
      assert.ok(
        summary.blockers.some((b) => /pHash/.test(b) && /MIN_PHASH_HAMMING/.test(b)),
        'must name the missing pHash evidence, not silently ignore it',
      );
    });

    it('refuses to recommend freezing when the minimum observed pairwise pHash distance falls below the threshold, even with perfect OCR health', () => {
      // 30 names, perfect OCR data, two axis images each — but ONE name's
      // pair is only 1 bit apart (Hamming distance 1), far below
      // MIN_PHASH_HAMMING's default of 10. Before this fix, `phash.min = 1`
      // against a threshold of 10 sailed through as `canFreeze: true` with
      // no mention of it anywhere.
      const results: CalibrationImageResult[] = [];
      for (let i = 0; i < 30; i++) {
        const name = `Name${i}`;
        const goodScores = [0.95, 0.96, 0.94];
        const badScores = [0.05, 0.06, 0.04];
        results.push(
          result({ name, axisId: 'wordmark', phash: '0000000000000000', goodScores, badScores }),
        );
        results.push(
          result({
            name,
            axisId: 'lockup',
            phash: i === 0 ? '0000000000000001' : '000000000000ffff',
            goodScores,
            badScores,
          }),
        );
      }
      const summary = summarize(results);
      assert.equal(
        summary.phash!.min,
        1,
        "fixture precondition: name 0's pair is only 1 bit apart",
      );
      assert.equal(summary.canFreeze, false);
      assert.ok(
        summary.blockers.some((b) => /minimum observed pairwise pHash distance/i.test(b)),
        'must name the phash violation specifically, not just fail silently',
      );
    });
  });

  describe('C2 — rates must be weighted by distinct name, not by raw check count', () => {
    it("is not fooled by one name's duplicate checks masking near-total failure across the rest of the golden set", () => {
      const results: CalibrationImageResult[] = [];
      // 29 distinct names, each contributing exactly ONE known-bad check
      // that is a clean FALSE ACCEPT (scores above threshold -> a miss).
      for (let i = 0; i < 29; i++) {
        results.push(result({ name: `Real${i}`, badScores: [0.95] }));
      }
      // One name contributes 1000 duplicate known-bad checks, all correctly
      // detected. Check-weighted, this reads as `1000 / 1029 ~= 0.972`
      // ("the gate works great") while 29 of 30 real names (96.7%) missed
      // completely.
      for (let i = 0; i < 1000; i++) {
        results.push(result({ name: 'Duplicated', badScores: [0.05] }));
      }
      const summary = summarize(results);
      assert.equal(summary.goldenCount, 30, 'fixture precondition: exactly 30 distinct names');
      assert.equal(
        summary.garbledConsidered,
        30,
        'must count DISTINCT NAMES with usable evidence, not 1029 raw checks',
      );
      // Name-weighted: 29 names each contribute a local rate of 0 (their
      // only check missed); one contributes a local rate of 1 (all 1000 of
      // its duplicates correctly detected). Averaged per NAME: (29*0+1)/30.
      assert.equal(summary.garbledDetectionRate, 1 / 30);
      assert.equal(summary.canFreeze, false);
      assert.ok(summary.blockers.some((b) => /garbled-detection rate/i.test(b)));
    });
  });

  describe('C3 — options may tighten the gate, never loosen it', () => {
    it('refuses to let minGoldenNames lower the real floor below 30, even for a caller-supplied 0 on zero evidence', () => {
      const summary = summarize([], { minGoldenNames: 0 });
      assert.equal(summary.canFreeze, false);
      assert.ok(summary.blockers.some((b) => /no results were provided/i.test(b)));
      assert.ok(summary.blockers.some((b) => /30/.test(b)));
    });

    it('refuses to let minAcceptableRate disable the rate safety net via 0 or a negative value', () => {
      // 30 names, every known-bad check a clean false accept (rate 0).
      const results = Array.from({ length: 30 }, (_, i) =>
        result({ name: `Name${i}`, goodScores: [0.95, 0.96, 0.94], badScores: [0.9, 0.91, 0.89] }),
      );
      for (const degenerate of [0, -1, -100]) {
        const summary = summarize(results, { minAcceptableRate: degenerate });
        assert.equal(summary.garbledDetectionRate, 0, `precondition broke for ${degenerate}`);
        assert.ok(
          summary.blockers.some(
            (b) => /garbled-detection rate/i.test(b) && /minimum acceptable/i.test(b),
          ),
          `minAcceptableRate: ${degenerate} must not disable the safety net`,
        );
        assert.equal(summary.canFreeze, false);
      }
    });

    it('treats an out-of-range minAcceptableRate (>1) as absent, falling back to the default, rather than making the check impossible to pass', () => {
      // Perfectly healthy 30-name dataset (rate 1 on both sides); an
      // honoured minAcceptableRate of 2 would make `1 < 2` true and force a
      // spurious block on data that could not possibly be cleaner.
      const results = Array.from({ length: 30 }, (_, i) =>
        result({ name: `Name${i}`, goodScores: [0.95, 0.96, 0.94], badScores: [0.05, 0.06, 0.04] }),
      );
      for (const outOfRange of [1.5, 2, 100]) {
        const summary = summarize(results, { minAcceptableRate: outOfRange });
        assert.equal(
          summary.blockers.some((b) => /minimum acceptable/i.test(b)),
          false,
          `minAcceptableRate: ${outOfRange} must fall back to the default on perfectly healthy data`,
        );
      }
    });

    it('honours a legitimate, non-degenerate minAcceptableRate override (loosening is allowed; disabling is not)', () => {
      // 21 of 30 names correctly detected, 9 missed: a real rate of 0.7,
      // neither 0 nor 1 nor a degenerate value.
      const results = [
        ...Array.from({ length: 21 }, (_, i) => result({ name: `Detected${i}`, badScores: [0.3] })),
        ...Array.from({ length: 9 }, (_, i) => result({ name: `Missed${i}`, badScores: [0.95] })),
      ];
      const strict = summarize(results, { minAcceptableRate: 0.9 });
      assert.equal(strict.garbledDetectionRate, 21 / 30);
      assert.ok(strict.blockers.some((b) => /garbled-detection rate/i.test(b)));

      const relaxed = summarize(results, { minAcceptableRate: 0.5 });
      assert.equal(
        relaxed.blockers.some((b) => /garbled-detection rate/i.test(b)),
        false,
        'a real, valid rate like 0.5 must be honoured, not silently reset to the default',
      );
    });
  });

  describe('C4 — canFreeze must require enough repeat runs to test for instability at all', () => {
    it('refuses to recommend freezing when no check has enough usable runs to test for a straddle (e.g. runsPerImage: 1)', () => {
      // 30 names, ONE run each, every score just above the threshold (0.86
      // vs 0.85) — structurally incapable of ever showing a straddle, since
      // `unstable` requires usableRuns >= 2. Before this fix this reported
      // `unstableChecks: []` and read as "checked, found stable" instead of
      // "never checked at all".
      const results = Array.from({ length: 30 }, (_, i) =>
        result({ name: `Name${i}`, goodScores: [0.86], badScores: [0.05] }),
      );
      const summary = summarize(results);
      assert.equal(
        summary.unstableChecks.length,
        0,
        'fixture precondition: nothing CAN be flagged unstable with 1 run each',
      );
      assert.equal(summary.canFreeze, false);
      assert.ok(
        summary.blockers.some((b) => /single usable OCR run/i.test(b)),
        'must block on insufficient runs for the instability check, not read silence as stability',
      );
    });
  });

  describe('C5 — a non-finite score must be excluded, never counted as a detection', () => {
    it('excludes a NaN score from every rate rather than letting it masquerade as a pass or a fail', () => {
      // Every one of 30 names has a known-bad check with 4 clean
      // false-accepts (0.95, well above the 0.85 threshold) plus one NaN.
      // Before the Number.isFinite guard, the naive mean of
      // [0.95,0.95,0.95,0.95,NaN] is NaN, and `NaN >= threshold` is `false`
      // in JavaScript — which a known-bad check reads as "correctly
      // detected", so this would have reported garbledDetectionRate: 1
      // (perfect) instead of the 0 (total miss) the four REAL scores show.
      const results = Array.from({ length: 30 }, (_, i) =>
        result({
          name: `Name${i}`,
          goodScores: [0.95, 0.96, 0.94],
          badScores: [0.95, 0.95, 0.95, 0.95, NaN],
        }),
      );
      const summary = summarize(results);
      assert.equal(
        summary.garbledDetectionRate,
        0,
        'four real 0.95 scores are an obvious miss; the NaN must not flip this to "detected"',
      );
      const anyBadCheck = summary.checks.find((c) => c.label === 'known-bad');
      assert.ok(anyBadCheck);
      assert.equal(
        anyBadCheck!.usableRuns,
        4,
        'the NaN run must be excluded, not counted as usable',
      );
      assert.equal(
        anyBadCheck!.pass,
        true,
        'mean of the 4 usable scores (0.95) is at/above threshold — correctly NOT detected',
      );
      assert.equal(summary.canFreeze, false);
      assert.ok(summary.blockers.some((b) => /garbled-detection rate/i.test(b)));
    });
  });
});

// ---------------------------------------------------------------------------
// runCalibration — wiring, using fully injected fakes (no live vendor calls)
// ---------------------------------------------------------------------------

describe('runCalibration', () => {
  it('generates every (name, axis) pair — including the Recraft native-SVG rasterization branch — runs the OCR gate n times each way, and rolls it into a summary', async () => {
    const golden = [{ name: 'Alpha Traders' }, { name: 'Beta & Sons' }];
    const palette: Array<[string, string]> = [
      ['#1a2b3c', '#e0c040'],
      ['#3caa55', '#101010'],
      ['#ff00aa', '#00ffaa'],
      ['#222266', '#eeeeee'],
    ];
    const pngs = await Promise.all(palette.map(([a, b]) => renderGradientPng(a, b)));

    const goodNames = new Set(golden.map((g) => g.name));
    const ocrGate: OcrGate = {
      async check(_png, brandName) {
        const isGood = goodNames.has(brandName);
        return {
          status: 'ok',
          verdict: {
            model: 'fake-model',
            transcription: brandName,
            score: isGood ? 0.95 : 0.05,
            pass: isGood,
            unsafe: false,
            checkedAt: '2026-07-31T00:00:00.000Z',
          },
        };
      },
    };

    let call = 0;
    const generatorCalls: StyleAxis[] = [];
    const generator: Generator = {
      async generate(axis) {
        generatorCalls.push(axis);
        const index = call++;
        if (axis.vendor === 'recraft') {
          const [from, to] = palette[index % palette.length]!;
          return {
            ok: true,
            costUsd: 0.08,
            concept: {
              axisId: '',
              vendor: 'recraft',
              png: new Uint8Array(0),
              nativeSvg: gradientSvg(from, to),
              vendorRequestId: `recraft-${index}`,
            },
          };
        }
        return {
          ok: true,
          costUsd: 0.06,
          concept: {
            axisId: '',
            vendor: axis.vendor,
            png: pngs[index % pngs.length]!,
            vendorRequestId: `ideogram-${index}`,
          },
        };
      },
    };

    const report = await runCalibration({
      generator,
      ocrGate,
      sources: nodeWasmSources(),
      golden,
      runsPerImage: 2,
    });

    assert.equal(generatorCalls.length, 6); // 2 names x 3 DEFAULT_AXES
    assert.equal(report.results.length, 6);
    assert.equal(report.generationFailures.length, 0);
    assert.equal(report.goldenCount, 2);
    assert.equal(report.imageCount, 6);
    assert.equal(report.runsPerImage, 2);
    assert.ok(report.generatedAt.length > 0);

    for (const r of report.results) {
      assert.ok(r.phash, `expected a phash for ${r.name}/${r.axisId}`);
      assert.equal(r.knownGood.runs.length, 2);
      assert.equal(r.knownBad.runs.length, 2);
      assert.equal(r.knownGood.targetName, r.name);
    }

    // The 'emblem' axis is Recraft-routed and went through the empty-png +
    // nativeSvg rasterization branch — prove it produced a real, decodable
    // image rather than silently short-circuiting to an empty result.
    const emblemResults = report.results.filter((r) => r.axisId === 'emblem');
    assert.equal(emblemResults.length, 2);
    assert.ok(emblemResults.every((r) => r.vendor === 'recraft' && r.phash !== null));

    assert.equal(report.summary.stylizedPassRate, 1);
    assert.equal(report.summary.garbledDetectionRate, 1);
    assert.ok(report.summary.phash);
  });

  it('records a generation failure instead of fabricating a result, and excludes it from the image set', async () => {
    const golden = [{ name: 'Solo Traders' }];
    const svg = gradientSvg('#112233', '#445566');
    const png = await renderGradientPng('#112233', '#445566');
    const generator: Generator = {
      async generate(axis) {
        if (axis.id === 'lockup') {
          return { ok: false, retryable: true, error: 'vendor returned 503' };
        }
        return axis.vendor === 'recraft'
          ? {
              ok: true,
              costUsd: 0.08,
              concept: { axisId: '', vendor: 'recraft', png: new Uint8Array(0), nativeSvg: svg },
            }
          : { ok: true, costUsd: 0.06, concept: { axisId: '', vendor: axis.vendor, png } };
      },
    };
    const ocrGate: OcrGate = {
      async check(_png, brandName) {
        return {
          status: 'ok',
          verdict: {
            model: 'fake',
            transcription: brandName,
            score: 0.95,
            pass: true,
            unsafe: false,
            checkedAt: '2026-07-31T00:00:00.000Z',
          },
        };
      },
    };

    const report = await runCalibration({
      generator,
      ocrGate,
      sources: nodeWasmSources(),
      golden,
      runsPerImage: 1,
    });

    assert.equal(report.results.length, 2); // wordmark + emblem generated; lockup failed
    assert.equal(report.generationFailures.length, 1);
    assert.equal(report.generationFailures[0]!.axisId, 'lockup');
    assert.match(report.generationFailures[0]!.error, /503/);
    assert.ok(report.results.every((r) => r.axisId !== 'lockup'));
  });

  it('never treats an unavailable OCR run as a pass or a fail, end to end', async () => {
    const golden = [{ name: 'Quiet Co' }];
    const svg = gradientSvg('#010203', '#040506');
    const png = await renderGradientPng('#010203', '#040506');
    const generator: Generator = {
      async generate(axis) {
        return axis.vendor === 'recraft'
          ? {
              ok: true,
              costUsd: 0.08,
              concept: { axisId: '', vendor: 'recraft', png: new Uint8Array(0), nativeSvg: svg },
            }
          : { ok: true, costUsd: 0.06, concept: { axisId: '', vendor: axis.vendor, png } };
      },
    };
    // Mirrors the OCR gate's own canary contract: every call reports
    // 'unavailable', exactly as it would for a vision response whose
    // prompt_tokens never cleared MIN_VISION_PROMPT_TOKENS.
    const ocrGate: OcrGate = {
      async check() {
        return { status: 'unavailable', error: 'prompt_tokens below MIN_VISION_PROMPT_TOKENS' };
      },
    };

    const report = await runCalibration({
      generator,
      ocrGate,
      sources: nodeWasmSources(),
      golden,
      runsPerImage: 3,
    });

    for (const r of report.results) {
      assert.ok(r.knownGood.runs.every((run) => run.status === 'unavailable'));
      assert.ok(r.knownBad.runs.every((run) => run.status === 'unavailable'));
    }
    assert.equal(report.summary.garbledDetectionRate, null);
    assert.equal(report.summary.stylizedPassRate, null);
    assert.equal(report.summary.canFreeze, false);
  });
});
