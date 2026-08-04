// ---------------------------------------------------------------------------
// LogoSmith configuration — bot identity, gig scoring, pricing anchors, and the
// hard caps and gate thresholds from PRD FR-5/FR-6/FR-14/§9.
// ---------------------------------------------------------------------------

import type {
  BotConfig,
  Gig,
  ProposalMilestone,
  RateCard,
  ResourceEstimate,
  ScorerConfig,
} from '@botguild/agent-core';
import { parseFaviconBrief } from './brief.js';

// --- Bot profile (registerBot) ----------------------------------------------
export const botProfile: BotConfig = {
  handlerId: 'bot-logosmith',
  name: 'LogoSmith',
  category: 'Design / Brand Identity',
  bio:
    'AI logos that can actually spell your name: three stylistically distinct concepts whose ' +
    'lettering is OCR-verified to read back as your brand, then the winner delivered as a true ' +
    'vector pack — SVG with zero embedded rasters, colour and mono masters, a full favicon set ' +
    'with favicon.ico and webmanifest, extracted brand hex codes, and a license-clean font pairing.',
  workingStyle: 'checkpoints',
  valueChainPosition: 'originator',
  toolchain: ['ideogram-3.0', 'recraft-v3', 'llama-4-scout', 'claude-haiku-4-5', 'resvg-wasm'],
  // §9 wording: readback threshold, vector parse, byte-verified dimensions,
  // ZIP integrity. NEVER trademark, NEVER taste.
  //
  // THESE TERMS DESCRIBE WHAT THE BOT DOES, AND NOTHING ELSE. They used to
  // promise that a failing artifact "is re-run free of charge, plus one
  // revision round on the selected mark" — and no re-run and no revision path
  // exists anywhere in this codebase (`grep -rn "revision"` returned only the
  // promise itself). A warranty registered with the marketplace is a
  // commitment, so it now states the three things that ARE implemented:
  // pre-delivery gating, a permanent evidence record, and a dispute response
  // built from that record. See the report accompanying this branch — building
  // a real re-run/revision path is a product decision, not a copy fix, and
  // reverting to the old wording without building it would be a false promise.
  warrantyTerms:
    'Every check named here runs BEFORE delivery, and an artifact that fails one is not ' +
    'shipped at all: the lettering of each delivered concept must read back against your brand ' +
    'name at the stated OCR threshold, logo.svg must pass a true-vector parse, every image must ' +
    'be at its exact contracted pixel dimensions, and the ZIP must be complete and readable. ' +
    'For 14 days after delivery the evidence page, the JSON validation report and the per-image ' +
    'license manifest remain available, recording every measurement behind those claims; if you ' +
    'raise a dispute, LogoSmith files that complete record with the platform. LogoSmith does ' +
    'not perform revisions or redesigns, and cannot cancel or refund a contract itself. ' +
    'Trademark clearance is NOT performed and NOT warranted.',
};

// --- Gig scoring -------------------------------------------------------------
export const scorerConfig: ScorerConfig = {
  categories: ['Design / Brand Identity', 'Design', 'Brand Identity', 'Graphic Design'],
  keywords: [
    'logo',
    'brand',
    'branding',
    'favicon',
    'icon',
    'wordmark',
    'mark',
    'identity',
    'vector',
    'svg',
  ],
  keywordsForFullScore: 3,
  // INTRODUCTORY $1 PRICING (2026-07-30) — REVERT TARGET: budgetMin 5,
  // budgetMax 150 (PRD-era range, sized for the $25 seed anchor). A read-only
  // live sample of 78 open BotGuild gigs measured real budgets at $0.08-$0.99
  // (median $0.44): the old floor scored the Budget factor 0 for every one of
  // them, and the old ceiling was 30-1875x any real budget. See SEED_PRICE_USD
  // below for the full rationale; all four recalibrated values move together.
  budgetMin: 0.25,
  budgetMax: 5,
  proposalThreshold: 40,
};

// --- Pricing -----------------------------------------------------------------
// Gig-listing anchors (PRD §11). The estimator may bid above these
// (max(1.5×cost, gig.budget)); pricingCalc supplies the deterministic baseline
// plus the timeline and the two milestone checkpoints.
//
// INTRODUCTORY $1 PRICING (2026-07-30). A read-only live sample of 78 open
// BotGuild gigs measured real budgets at $0.08-$0.99 (median $0.44) — roughly
// 50x below the PRD's $25 seed anchor. User ruling: "Go ahead with $1
// introductory pricing. We will revert to the original pricing later" — this
// is a deliberate, reversible promotional price, not a permanent repricing.
//
// ALL FOUR VALUES BELOW MOVE TOGETHER, because the anchor alone is inert:
// `createProposer` (proposer.ts) uses the cost ESTIMATOR's price whenever one
// is wired up (it is, for the paid proposer — see index.ts), and only falls
// back to this file's `pricingCalc` price if the estimator throws. The
// estimator's bid is `max(round(1.5×cost), gig.budget)` (bidPrice() in
// estimator.ts), where absent a live Claude estimate `cost =
// applyRateCard(fallbackEstimate, rateCard)`. The PRD-era rate card priced
// that fallback at $6.35 (verified below), i.e. a $10 floor — already
// 10-125x every budget in the live sample, so lowering just this constant
// would have kept bidding $10 regardless of what SEED_PRICE_USD said. See the
// `rateCard` comment below for the recalibrated arithmetic, and
// config.test.ts's "produces a bid floor..." test, which pins the actual
// floor rather than this constant.
//
// REVERT TARGET: SEED_PRICE_USD 25 (PRD §11).
export const SEED_PRICE_USD = 1;

// REVERT TARGET (PRD-era rate card): perClaudeCall 0.05, perKToken 0.01,
// perComputeMinute 0.05, perRun 0.5, fixedOverhead 5 — against
// `fallbackEstimate` below, applyRateCard gives 5 + 8×0.05 + 15×0.01 + 6×0.05
// + 1×0.5 = $6.35, so bidPrice's target = round(1.5×6.35) = $10 (arithmetic
// verified in Node, not by inspection). PRD-era SEED_PRICE_USD=25 only "won"
// the max() because the PRD assumed gig.budget ran near the $25 anchor too;
// against the live sample's real budgets, this $10 floor would have dominated
// instead. Recalibrated so applyRateCard(fallbackEstimate, rateCard) =
// 0.05 + 8×0.002 + 15×0.004 + 6×0.003 + 1×0.25 = $0.394, and
// round(1.5×0.394) = $1 — landing exactly on the introductory anchor, with
// headroom above the ~$0.20-0.40 real per-job vendor cost (IMAGE_COST_USD)
// and below the $0.99 top of the live budget sample.
export const rateCard: RateCard = {
  perClaudeCall: 0.002,
  perKToken: 0.004,
  perBrowserMinute: 0, // no browser in this bot (unchanged)
  perComputeMinute: 0.003,
  perRun: 0.25,
  fixedOverhead: 0.05,
};

export const fallbackEstimate: ResourceEstimate = {
  claudeCalls: 8,
  claudeKTokens: 15,
  browserMinutes: 0,
  computeMinutes: 6,
  runs: 1,
};

export function pricingCalc(gig: Gig): {
  price: number;
  timeline: string;
  milestones: ProposalMilestone[];
} {
  const description = gig.description ?? '';
  // Free-funnel gigs anchor at $0 (US-2/US-3) and go through the estimator-free
  // proposer — otherwise the 1.5x-cost floor would re-price them. A favicon gig
  // is recognised by its brief shape; the taster shares the paid brief shape
  // and is recognised by its $0 budget.
  const isFavicon = parseFaviconBrief(description).ok;
  if (isFavicon || (gig.budget ?? 0) === 0) {
    return {
      price: 0,
      timeline: '1 business day',
      milestones: [
        {
          title: isFavicon
            ? 'Milestone 1 — Favicon package from your logo'
            : 'Milestone 1 — One free concept with its OCR verdict',
          duration: '1 business day',
          deliverables: isFavicon
            ? [
                'ZIP: favicon.ico (16/32/48, parse-back verified), PNGs at 16/32/48/180/192/512, site.webmanifest, HTML snippet.',
              ]
            : [
                'One 1024px logo concept with its lettering-readback verdict attached as labelled, non-blocking evidence.',
              ],
        },
      ],
    };
  }

  return {
    price: SEED_PRICE_USD,
    timeline: '2 business days',
    milestones: [
      {
        title: 'Milestone 1 — Three OCR-passing concepts',
        duration: '1 business day',
        deliverables: [
          'Three 1024px logo concepts on three distinct declared style axes.',
          'An OCR readback verdict per concept (model id, transcription, similarity score).',
          'A live progress page showing each concept and its verdict as it lands.',
        ],
      },
      {
        title: 'Milestone 2 — True-vector brand pack',
        duration: '1 business day',
        deliverables: [
          'logo.svg — parse-verified true vector, zero embedded rasters, outlined paths.',
          'Colour and mono PNG masters at 1024px and 2048px.',
          'Favicon set: 16/32/48/180/192/512 plus favicon.ico, site.webmanifest, HTML snippet.',
          'brand.json — extracted hex codes and a license-clean Google Fonts pairing.',
          'JSON validation report and per-image license manifest.',
        ],
      },
    ],
  };
}

// --- Hard caps (FR-5, FR-14) --------------------------------------------------
export const CONCEPT_COUNT = 3;
export const MAX_REGENS_PER_SLOT = 2;

// INTRODUCTORY $1 PRICING — REVERT TARGET: 2.5 (PRD §11, ~10% of the $25
// anchor). Against the $1 anchor, 2.5 would exceed revenue 2.5x on every job,
// so this cannot just shrink proportionally — it must stay BELOW
// SEED_PRICE_USD (see config.test.ts's "never lets a capped job cost more
// than it earns"). Recalibrated to 0.6 (60% of the $1 anchor).
//
// VERIFIED (Node, not by inspection) against TODAY'S fixed axis routing
// (axes.ts: wordmark+lockup -> ideogram, emblem -> recraft) and IMAGE_COST_USD:
// the absolute worst case — every one of the 3 concept slots burning its full
// FR-5 allowance of 3 attempts (1 initial + MAX_REGENS_PER_SLOT regens) —
// costs exactly 2×3×$0.06 + 1×3×$0.08 = $0.60. That is precisely this cap,
// with zero slack: today, no job is ever spend-capped short of its full
// regeneration allowance, but there is also no headroom left for a vendor
// price rise, an added concept slot, or a costlier axis-vendor reassignment
// before the cap WOULD start truncating regenerations that used to complete.
// `decideSlotAction` is still a stop-AFTER threshold in general, not a
// ceiling (checked BEFORE each generation, so the call that crosses the line
// completes — see its docstring in pipeline.ts) — that policy has no room to
// actually bite mid-regeneration under today's numbers, but do not read the
// $0.60/$0.60 exact match as slack; it is the opposite.
//
// Stage 2 adds at most one further ~$0.20 Vectorizer.ai call NOT counted
// against this cap (runVectorStage's docstring in pipeline.ts) unless the
// winning concept came from Recraft's native-SVG path, which skips it —
// so worst-case total real vendor spend on a paid job (stage 1 + stage 2) is
// $0.60 + $0.20 = $0.80 against the $1 anchor, before any overhead the
// estimator's rateCard models separately. The buyer-facing delivery note
// quotes both this cap and the realized spend either way.
export const MAX_SPEND_USD = 0.6;
export const FREE_GIGS_PER_PAYER = 3;
export const FREE_GIG_WINDOW_DAYS = 30;

/** Failed moderation attempts before the buyer gets a thread status message (FR-2). */
export const MODERATION_ATTEMPTS_BEFORE_NOTICE = 3;

/**
 * `park_reason` for a brief that could not be READ because the extraction
 * vendor was down — as opposed to a brief that is wrong, which is terminal.
 *
 * Shared rather than written as a literal at both ends, because the park site
 * (pipeline.ts) and the buyer-facing vendor name (sweeps.ts's
 * `PARK_REASON_VENDOR`) must agree: a reason with no entry there degrades to
 * "a vendor LogoSmith depends on", which is true but vague in the one message
 * that ends the contract.
 */
export const BRIEF_OUTAGE_PARK_REASON = 'brief_extraction_outage';

/**
 * The FR-17 gate name every selection event is recorded under, and the `result`
 * marking a message the Haiku selection fallback read a pick out of.
 *
 * They live here, beside `BRIEF_OUTAGE_PARK_REASON`, because they are a
 * protocol between two modules that must not drift: `sweeps.ts` WRITES them
 * when it resolves a winner, and `disputes.ts` READS them to recover the
 * buyer's own words behind an inferred pick. Gate names are otherwise a local
 * literal per module in this app (`MODERATION_GATE` is declared twice), which
 * is tolerable where a drift costs a missing summary — not where it costs the
 * quoted evidence in a dispute response.
 */
export const SELECTION_GATE = 'selection';
export const SELECTION_INFERENCE_SELECTED = 'inference-selected';

/** `claimed` jobs older than this with no checkpoint are re-enqueued (§12). */
export const STUCK_CLAIM_MINUTES = 30;

/**
 * How long a job may sit parked before LogoSmith gives up on it, tells the
 * buyer, and moves it to a terminal state.
 *
 * WHY THIS EXISTS. A retryable vendor failure parks WITHOUT consuming an FR-5
 * regeneration attempt, so that a 45-minute outage cannot burn a paid job's
 * regeneration budget on a 503 that generated nothing. That leaves parking
 * itself unbounded: a permanently dead vendor would loop park → unpark → fail →
 * park forever — no spend, but the job never delivers, never refunds, and never
 * tells the buyer. This is the independent bound.
 *
 * WHY SIX HOURS. The milestone promises one business day. A job parked six
 * hours has burned a quarter of that with zero progress, after roughly
 * twenty-four automatic retries at the 15-minute cron cadence. Every transient
 * outage in this vendor set resolves well inside that window; past it a
 * permanent cause — a revoked key, a withdrawn model, a suspended account — is
 * far likelier than a recovering one, and continuing to wait in silence is
 * worse for the buyer than an honest stop. Six hours also leaves roughly
 * eighteen hours of the SLA for the buyer to cancel or re-brief INSIDE the
 * promised window, rather than discovering the failure after it was missed.
 *
 * Measured against `jobs.parked_since` — the start of the current failing
 * spell. See migrations/0002_parked_since.sql for why no other column works.
 */
export const PARKED_GIVE_UP_HOURS = 6;

/** Hours after M1 delivery before the default-selection rule fires (FR-9). */
export const SELECTION_TIMEOUT_HOURS = 72;

// --- Gate thresholds (§9) -----------------------------------------------------
// PROVISIONAL until the Phase 2 calibration freezes them against the ≥30-name
// golden set. Do NOT loosen these to make a job pass — §15 tracks regen burn
// precisely so drift triggers prompt tuning, never silent gate-loosening.
export const OCR_SIMILARITY_THRESHOLD = 0.85; // PROVISIONAL
export const MIN_PHASH_HAMMING = 10; // PROVISIONAL

// --- Models -------------------------------------------------------------------
export const HAIKU_MODEL_ID = 'claude-haiku-4-5';
export const SCOUT_MODEL_ID = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const FLUX_MODEL_ID = '@cf/black-forest-labs/flux-2-klein';

/** Haiku 4.5 list pricing, USD per million tokens — spend accounting. */
export const HAIKU_PRICING_PER_MTOK = {
  input: 1.0,
  output: 5.0,
  cacheWrite: 1.25,
  cacheRead: 0.1,
} as const;

/**
 * Conservative flat per-image vendor costs for the FR-5 spend ledger (§11).
 *
 * THESE ARE PLANNING FIGURES, AND FOR RECRAFT AND VECTORIZER ALSO FALLBACKS.
 * Both of those vendors' live APIs report what they actually charged on a 200
 * — Recraft in the body's `credits` field, Vectorizer.ai in the
 * `x-credits-charged` RESPONSE HEADER (see `recraftCreditsToUsd` and
 * `vectorizerCreditsToUsd` below) — and `generate.ts`/`vectorize.ts` bill the
 * ledger from those reports in preference to this table. Those entries stay as
 * (a) the value used when a response carries no usable credit count, and
 * (b) the numbers the worst-case-burn invariant in `config.test.ts` sizes
 * `MAX_SPEND_USD` against — a cap has to be chosen from figures known BEFORE
 * the calls are made. (The vectorizer entry is not IN that invariant at all:
 * stage 2's single conversion is deliberately outside the FR-5 cap — see
 * `MAX_SPEND_USD` above and `runVectorStage` in pipeline.ts.)
 *
 * Reading the real charge STRENGTHENS that cap rather than weakening it: if a
 * vendor ever bills above its planning figure, the ledger now sees the
 * difference and `decideSlotAction` stops sooner, where before the overage was
 * invisible and the cap under-bit by exactly the amount it could not see.
 */
export const IMAGE_COST_USD = {
  ideogram: 0.06,
  recraft: 0.08,
  flux: 0.001,
  vectorizer: 0.2,
} as const;

/**
 * How many Recraft credits buy a dollar.
 *
 * WHERE THIS NUMBER COMES FROM, because it is DERIVED and not independently
 * measured. Both live probe calls on 2026-08-04 (one `recraftv3`
 * `vector_illustration` image, `n: 1`) reported `credits: 80` in the response
 * body. Reconciling that measured count against the documented per-image price
 * this file already carried — `IMAGE_COST_USD.recraft` = $0.08 — gives exactly
 * $0.001 per credit, i.e. the 1000 below. The vendor publishes the credit
 * COUNT, not the credit PRICE, so the price half rests on that reconciliation.
 *
 * `config.test.ts` pins the agreement (80 credits must equal
 * `IMAGE_COST_USD.recraft`), so moving either constant without the other fails
 * loudly rather than silently re-pricing the ledger. If Recraft reprices a
 * credit, THIS is the constant that moves; the vendor's own `credits` field
 * keeps reporting quantity correctly either way, which is the whole reason to
 * read it instead of hardcoding a dollar figure that drifts unobserved.
 */
export const RECRAFT_CREDITS_PER_USD = 1000;

/**
 * What a Recraft response's `credits` field is worth in dollars, or
 * `undefined` when the response reported no usable count.
 *
 * ONLY A POSITIVE FINITE NUMBER IS ACCEPTED, and the direction of that
 * strictness is deliberate. Every rejected shape — absent, `0`, negative,
 * `NaN`, a string, a nested object — falls back at the call site to
 * `IMAGE_COST_USD.recraft`, i.e. to the conservative planning figure rather
 * than to zero. UNDER-REPORTING SPEND IS THE DANGEROUS DIRECTION: a retryable
 * failure deliberately consumes no FR-5 attempt, so `spendUsd` is the only
 * thing bounding the park → unpark → regenerate → park loop, and it cannot
 * bound spend it has been told was free.
 */
export function recraftCreditsToUsd(credits: unknown): number | undefined {
  if (typeof credits !== 'number' || !Number.isFinite(credits) || credits <= 0) return undefined;
  // Divide rather than multiply by a 0.001 literal: 80 / 1000 is the nearest
  // double to 0.08 (i.e. `=== 0.08`), where 80 * 0.001 lands on 0.08000000000000002.
  // The outer round mirrors pipeline.ts/report.ts's `roundUsd` for anything
  // that does not divide cleanly.
  return Math.round((credits / RECRAFT_CREDITS_PER_USD) * 1e6) / 1e6;
}

/**
 * How many Vectorizer.ai credits buy a dollar.
 *
 * DERIVED, NOT MEASURED — exactly as `RECRAFT_CREDITS_PER_USD` is, and for
 * exactly the same reason. The three live probe calls on 2026-08-04 reported
 * `x-credits-calculated: 1.000000` for one `output.file_format=svg`
 * conversion, so the QUANTITY (one credit per conversion) is measured. The
 * PRICE is not: vectorizer.ai publishes a credit COUNT, and 1 credit ≈ $0.20
 * only at the entry subscription tier — the rate improves with volume, so a
 * larger plan makes this constant wrong in the SAFE direction (we would bill
 * the ledger more than we paid). Reconciling the measured 1.000000 against the
 * per-conversion price this file already carried — `IMAGE_COST_USD.vectorizer`
 * = $0.20 — gives the 5 below.
 *
 * `config.test.ts` pins the agreement (1 credit must equal
 * `IMAGE_COST_USD.vectorizer`), so moving either constant without the other
 * fails loudly rather than silently re-pricing stage 2's ledger. If a plan
 * change moves the credit price, THIS is the constant that moves.
 */
export const VECTORIZER_CREDITS_PER_USD = 5;

/**
 * What a Vectorizer.ai `x-credits-charged` response header is worth in
 * dollars, or `undefined` when the response reported no usable count.
 *
 * TAKES A STRING WHERE ITS RECRAFT SIBLING TAKES A NUMBER, because this vendor
 * reports the charge in a HEADER (the body is raw SVG, so there is no JSON
 * field to read) and `Headers.get` hands back `string | null`. The parse
 * therefore lives here rather than at the call site.
 *
 * ONLY A PLAIN POSITIVE DECIMAL IS ACCEPTED — the `1.000000` / `0.000000`
 * shape actually measured. Everything else (absent, empty, `0`, negative,
 * exponent notation, hex — note `Number('0x10')` is 16 — or a number with
 * trailing junk) falls back at the call site to `IMAGE_COST_USD.vectorizer`,
 * i.e. UPWARD to the conservative planning figure. UNDER-REPORTING SPEND IS
 * THE DANGEROUS DIRECTION, identically to Recraft: a retryable vectorize
 * failure parks without consuming an FR-5 attempt, so realized `spentUsd` is
 * the only thing that ever ends that park -> unpark loop (`sweepParkedJobs`),
 * and it cannot bound spend it has been told was free.
 *
 * ONE CONSEQUENCE, STATED SO IT IS NOT MISTAKEN FOR A BUG: a FREE test-mode
 * call reports `x-credits-charged: 0.000000` and is therefore billed the full
 * $0.20 planning figure. That is deliberate. `mode=test` is a verification
 * tool documented in the README and is never sent by this Worker, so the only
 * way a production response reports a zero charge is a vendor anomaly — and
 * over-billing an anomaly is the safe direction to be wrong in.
 */
export function vectorizerCreditsToUsd(credits: unknown): number | undefined {
  if (typeof credits !== 'string') return undefined;
  const trimmed = credits.trim();
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round((parsed / VECTORIZER_CREDITS_PER_USD) * 1e6) / 1e6;
}

// --- Pack contract (§8) --------------------------------------------------------
export const FAVICON_SIZES = [16, 32, 48, 180, 192, 512] as const;
export const ICO_SIZES = [16, 32, 48] as const;
export const MASTER_SIZES = [1024, 2048] as const;
