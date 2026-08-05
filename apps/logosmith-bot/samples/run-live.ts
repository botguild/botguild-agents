/**
 * Live end-to-end sample runner — drives the SHIPPED pipeline modules against
 * the REAL vendors, exactly as the Worker does. Not part of the build; nothing
 * imports it, so it never reaches the bundle.
 *
 * This spends real money. Concepts are cached to the output directory by
 * filename, so a re-run after a crash reuses what was already paid for rather
 * than buying it twice — the first version of this script cost $0.20 twice
 * before that was added.
 *
 *   cd apps/logosmith-bot
 *   set -a && . .dev.vars && . ../../.env.local && set +a
 *   OUT_DIR=samples/<name> BRIEF=samples/briefs/<name>.json npx tsx samples/run-live.ts
 *
 * Requires: IDEOGRAM_API_KEY, RECRAFT_API_KEY, ANTHROPIC_API_KEY,
 * VECTORIZER_AI_TOKEN, GOOGLE_FONTS_API_KEY, CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_API_TOKEN (the last two back the Workers AI lettering gate, which
 * is a binding in the Worker and a REST shim here).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { createAxisCompiler } from '../src/axes.js';
import { createGenerator } from '../src/generate.js';
import { createVectorizer } from '../src/vectorize.js';
import { createOcrGate } from '../src/gates/ocr.js';
import { perceptualHash, checkDistinctness, toHex } from '../src/gates/phash.js';
import { readPngDimensions } from '../src/gates/dimensions.js';
import { renderSvgToPixmap, renderSvgToPng } from '../src/pack/render.js';
import { nodeWasmSources } from '../src/pack/wasm.node.js';
import { fetchFontPairing } from '../src/pack/fonts.js';
import { buildPack } from '../src/pack/index.js';
import { OCR_SIMILARITY_THRESHOLD, MIN_PHASH_HAMMING } from '../src/config.js';
import type { LogoBrief } from '../src/types.js';

/** §8: concepts are generated, and Recraft SVGs rasterized, at this edge. */
const CONCEPT_PX = 1024;

const OUT = process.env.OUT_DIR!;
const brief = JSON.parse(readFileSync(process.env.BRIEF!, 'utf8')) as LogoBrief;
mkdirSync(`${OUT}/concepts`, { recursive: true });
mkdirSync(`${OUT}/pack`, { recursive: true });

/**
 * Workers AI over REST. In the Worker this is the `AI` binding; the gate only
 * ever sees `AiLike`, which is what makes it runnable here at all.
 */
const ai = {
  async run(model: string, input: Record<string, unknown>): Promise<unknown> {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/${model}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      },
    );
    const j = (await r.json()) as { result?: unknown; errors?: unknown };
    if (!r.ok) throw new Error(`workers ai ${r.status}: ${JSON.stringify(j.errors)}`);
    return j.result;
  },
};

const log = console.log;

/** pHash needs a decoded pixmap; resvg decodes a data: URI, so no extra decoder. */
const toPixmap = async (png: Uint8Array, sources: Awaited<ReturnType<typeof nodeWasmSources>>) =>
  renderSvgToPixmap(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CONCEPT_PX}" height="${CONCEPT_PX}" viewBox="0 0 ${CONCEPT_PX} ${CONCEPT_PX}"><image width="${CONCEPT_PX}" height="${CONCEPT_PX}" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"/></svg>`,
    CONCEPT_PX,
    sources,
  );

(async () => {
  let spend = 0;
  const sources = await nodeWasmSources();

  log(`\n══ ${brief.brandName} ══════════════════════════════════════\n`);

  log('── 1. axis compilation (Haiku) ─────────────────────────────');
  const axes = await createAxisCompiler({
    anthropic: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  }).compile(brief);
  for (const a of axes) log(`  ${a.id.padEnd(9)} → ${a.vendor}`);

  log('\n── 2. generation ───────────────────────────────────────────');
  const generator = createGenerator({
    fetchImpl: fetch as never,
    ai,
    ideogramApiKey: process.env.IDEOGRAM_API_KEY!,
    recraftApiKey: process.env.RECRAFT_API_KEY!,
  });
  const concepts: Array<{
    axis: (typeof axes)[number];
    png: Uint8Array;
    nativeSvg?: string;
  }> = [];
  for (const axis of axes) {
    const pngPath = `${OUT}/concepts/concept-${axis.id}.png`;
    const svgPath = `${OUT}/concepts/concept-${axis.id}.svg`;
    if (existsSync(pngPath)) {
      const png = new Uint8Array(readFileSync(pngPath));
      const d = readPngDimensions(png);
      log(`  ${axis.id.padEnd(9)} CACHED  ${d?.width}x${d?.height}  $0 (already paid)`);
      concepts.push({
        axis,
        png,
        nativeSvg: existsSync(svgPath) ? readFileSync(svgPath, 'utf8') : undefined,
      });
      continue;
    }
    const t0 = Date.now();
    const r = await generator.generate(axis, axis.prompt);
    if (!r.ok) {
      log(`  ${axis.id.padEnd(9)} FAILED — ${r.error}`);
      continue;
    }
    spend += r.costUsd;
    // Persist the native SVG BEFORE anything that can throw, so a crash does
    // not discard bytes the vendor has already been paid for.
    if (r.concept.nativeSvg) writeFileSync(svgPath, r.concept.nativeSvg);
    const png =
      r.concept.png.length > 0
        ? r.concept.png
        : await renderSvgToPng(r.concept.nativeSvg!, CONCEPT_PX, sources);
    writeFileSync(pngPath, png);
    const d = readPngDimensions(png);
    log(
      `  ${axis.id.padEnd(9)} ${r.concept.vendor.padEnd(8)} ${d?.width}x${d?.height} ` +
        `$${r.costUsd}  ${Date.now() - t0}ms${r.concept.nativeSvg ? '  [native vector]' : ''}`,
    );
    concepts.push({ axis, png, nativeSvg: r.concept.nativeSvg });
  }

  log('\n── 3. gates ────────────────────────────────────────────────');
  const ocrGate = createOcrGate({ ai });
  const scored: Array<(typeof concepts)[number] & { score: number; phash: bigint }> = [];
  for (const c of concepts) {
    const o = await ocrGate.check(c.png, brief.brandName);
    const ph = perceptualHash(await toPixmap(c.png, sources));
    if (o.status !== 'ok') {
      log(`  ${c.axis.id.padEnd(9)} readback UNAVAILABLE — ${o.error}`);
      continue;
    }
    log(
      `  ${c.axis.id.padEnd(9)} "${o.verdict.transcription}" ${o.verdict.score.toFixed(2)} ` +
        `${o.verdict.pass ? 'PASS' : 'FAIL'} (>= ${OCR_SIMILARITY_THRESHOLD})`,
    );
    scored.push({ ...c, score: o.verdict.score, phash: ph });
  }
  const dist = checkDistinctness(
    scored.map((s, i) => ({ slot: i + 1, phash: toHex(s.phash), axisId: s.axis.id })),
  );
  for (const p of dist.pairs) {
    log(
      `  ${scored[p.a - 1]!.axis.id} vs ${scored[p.b - 1]!.axis.id}: hamming ${p.distance} ` +
        `${p.pass ? 'PASS' : 'FAIL'} (>= ${MIN_PHASH_HAMMING})`,
    );
  }
  log(`  distinctness: ${dist.pass ? 'PASS' : 'FAIL'}`);

  const winner = [...scored].sort((a, b) => b.score - a.score)[0];
  if (!winner) throw new Error('no concept survived the gates');
  log(`\n── 4. winner: ${winner.axis.id} (${winner.score.toFixed(2)}) ──────────────────`);

  const vectorizer = createVectorizer({
    fetchImpl: fetch as never,
    vectorizerToken: process.env.VECTORIZER_AI_TOKEN!,
  });

  log('\n── 5. vectorise ────────────────────────────────────────────');
  // CACHED FOR THE SAME REASON THE CONCEPTS ARE. A Vectorizer.ai trace is
  // $0.20 and is not deterministic — a re-run returns a slightly different
  // path set — so re-buying it both spends money and silently changes the
  // committed sample out from under whatever the re-run was meant to show.
  // Delete this file to buy a fresh trace on purpose.
  const vectorPath = `${OUT}/concepts/vector-${winner.axis.id}.svg`;
  const vec = existsSync(vectorPath)
    ? ({
        ok: true,
        svg: readFileSync(vectorPath, 'utf8'),
        source: 'vectorizer',
        costUsd: 0,
      } as const)
    : await vectorizer.toVector({ png: winner.png, nativeSvg: winner.nativeSvg });
  if (!vec.ok) throw new Error(`vectorise failed: ${vec.error}`);
  spend += vec.costUsd;
  if (!existsSync(vectorPath)) writeFileSync(vectorPath, vec.svg);
  log(
    `  ${vec.source}  $${vec.costUsd}${vec.costUsd === 0 ? ' (cached — already paid)' : ''}  ` +
      `${(vec.svg.length / 1024).toFixed(1)}KB`,
  );

  // The documented gap: only the emblem axis routes to Recraft, so ~2 of 3
  // buyers receive a TRACED raster rather than a native vector. Trace one
  // deliberately so the two paths can be compared rather than assumed.
  const raster = scored.find((s) => !s.nativeSvg);
  if (raster && vec.source === 'recraft-native') {
    log(`\n── 5b. trace comparison (${raster.axis.id}, the path ~2/3 of buyers get) ──`);
    const traced = await vectorizer.toVector({ png: raster.png });
    if (traced.ok) {
      spend += traced.costUsd;
      writeFileSync(`${OUT}/concepts/traced-${raster.axis.id}.svg`, traced.svg);
      log(`  ${traced.source}  $${traced.costUsd}  ${(traced.svg.length / 1024).toFixed(1)}KB`);
    } else {
      log(`  FAILED — ${traced.error}`);
    }
  }

  log('\n── 6. build pack ───────────────────────────────────────────');
  const fonts = await fetchFontPairing({
    fetchImpl: fetch as never,
    apiKey: process.env.GOOGLE_FONTS_API_KEY!,
  });
  const pack = await buildPack({
    svg: vec.svg,
    brandName: brief.brandName,
    sources,
    fonts,
    // The same gate stage 1 read the lettering with, pointed at the favicon to
    // prove the OPPOSITE: a favicon that reads back as the brand name is the
    // whole lockup shrunk to 32 px. Passing it here is what makes this sample
    // exercise the shipped path rather than a degraded one.
    ocr: ocrGate,
  });
  for (const [name, bytes] of Object.entries(pack.files))
    writeFileSync(`${OUT}/pack/${name}`, bytes);
  writeFileSync(`${OUT}/${brief.brandName.toLowerCase()}-brand-pack.zip`, pack.zip);
  log(`  fonts: ${fonts.heading.family} / ${fonts.body.family}`);
  log(`  ${Object.keys(pack.files).length} files, zip ${(pack.zip.length / 1024).toFixed(0)}KB`);
  log(
    `  gates pass: ${pack.gates.pass}  violations: ${JSON.stringify(pack.gates.vector.violations)}`,
  );
  log(`  palette: ${pack.brand.colors.map((c) => c.hex).join(' ')}`);

  const fav = pack.gates.favicon;
  log('\n── 7. favicon derivation ───────────────────────────────────');
  log(`  source: ${fav.source}${fav.reason ? ` — ${fav.reason}` : ''}`);
  if (fav.crop)
    log(
      `  crop: ${fav.crop.size}x${fav.crop.size} at ${fav.crop.x},${fav.crop.y} of a ` +
        `${fav.crop.probeWidth}x${fav.crop.probeHeight} analysis render`,
    );
  log(`  components: ${fav.textComponents} lettering, ${fav.markComponents} mark candidate(s)`);
  log(`  mark coverage of the icon: ${(fav.coverage * 100).toFixed(1)}%`);
  log(
    `  ink: ${fav.ink.opaquePixels} opaque px in ${fav.ink.file} (${fav.ink.pass ? 'PASS' : 'FAIL'})`,
  );
  log(
    `  lettering readback: ${fav.text.status}` +
      (fav.text.status === 'ok'
        ? ` "${fav.text.transcription}" ${fav.text.letteringChars} chars, ` +
          `${(fav.text.brandSimilarity ?? 0).toFixed(2)} vs the brand name — ` +
          `${fav.text.pass ? 'no wordmark on the favicon' : 'STILL READS AS THE WORDMARK'}`
        : ''),
  );

  log(`\n══ REAL VENDOR SPEND THIS RUN: $${spend.toFixed(3)} ═══════════\n`);
})().catch((e: Error) => {
  console.error('RUN FAILED:', e.message);
  process.exit(1);
});
