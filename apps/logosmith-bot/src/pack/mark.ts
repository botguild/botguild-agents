// ---------------------------------------------------------------------------
// Favicon mark derivation (FR-11).
//
// A FAVICON NEEDS A MARK, NOT A SHRUNKEN LOGO. `buildPack` used to render the
// favicon set by downscaling the WHOLE winning logo. Every gate passed —
// dimensions exact, ICO parsed back, ZIP complete — because none of them asked
// whether the result was legible. The JiffyApp sample is the proof: a wide
// lockup (the wordmark "Jiffyapp" plus a rocket, a bolt and sparkles) rendered
// at 32 px is grey mush, and `favicon.ico` inherited it because it is assembled
// from those same PNGs. Measured on that delivery: 9.3% of the 32 px icon
// carried anything other than background, and the vision model read the whole
// brand name back off it — a favicon with legible eight-letter lettering is a
// favicon nobody can read.
//
// So this module finds the logo's PICTORIAL MARK and hands `buildPack` a
// square crop of it. It is pure geometry over the rendered pixmap — no vendor
// call, no model, nothing to hallucinate:
//
//   1. Render the logo once at MARK_PROBE_PX and decide what "background" is
//      (the modal colour of the border ring, or transparency).
//   2. Label 8-connected foreground components.
//   3. Find the TEXT BAND. Lettering is many components of similar height
//      sharing one horizontal band; a mark is not. The band is the run of rows
//      around the row that the most components cross.
//   4. Everything outside the band is mark candidate ink. Cluster it by
//      proximity — the rocket is one cluster, the bolt-and-sparkles another.
//   5. Square-crop the best cluster, SLIDING the crop to the position that
//      admits the least foreign ink, so a neighbouring letter does not bleed
//      into the corner.
//
// WHY A VISION CALL IS NOT USED TO FIND THE BOX. It was considered and
// rejected on this branch's own evidence: Task 17's canary exists because the
// pinned vision model returned a confident, well-formed, entirely hallucinated
// answer when it could not see the image at all. A bounding box is exactly the
// kind of precise spatial claim that model is worst at, and a wrong box is
// unfalsifiable without the geometry anyway — so the geometry does the finding
// and the model does what it is reliably good at: reading text back off a
// finished image, which is how the crop is VERIFIED in `pack/index.ts`.
//
// NOTHING HERE THROWS AND NOTHING HERE DECIDES. `deriveFaviconMark` returns a
// crop or a documented reason it found none; `buildPack` owns the fallback to
// the whole logo, so a derivation that finds nothing costs a buyer exactly
// today's deliverable and never a delivery.
// ---------------------------------------------------------------------------

import type { Pixmap } from '../types.js';
import { renderSvgToPixmap } from './render.js';
import type { WasmSources } from './wasm.js';

/**
 * The edge the geometry is measured at.
 *
 * Large enough that a thin mark survives as its own component (Task 23
 * measured a hairline monogram rendering to ZERO opaque pixels at 16 px and
 * 1568 at 512 — measure large, not small), small enough that the flood fill
 * and the sliding search stay trivial. Measured on the JiffyApp lockup at
 * this size: 19 components, of which 8 are the wordmark and 11 the marks.
 */
export const MARK_PROBE_PX = 512;

/** Alpha at or below this is background whatever its colour channels say. */
const ALPHA_FLOOR = 16;

/**
 * Per-channel tolerance for "this pixel is the background colour".
 *
 * Chebyshev rather than Euclidean: it is the cheap conservative choice, and
 * being conservative here means treating a marginally-off pixel as background,
 * which shrinks a component rather than inventing one.
 */
const BACKGROUND_TOLERANCE = 32;

/**
 * The border ring must be this uniform before its modal colour is believed to
 * be a background FIELD. Below it the artwork bleeds to the edge or the
 * background is a gradient, and subtracting one colour would carve holes in
 * the artwork — so only transparency counts as background instead.
 */
const MIN_BACKGROUND_RING_SHARE = 0.6;

/** Components smaller than this are antialiasing crumbs, not artwork. */
const MIN_COMPONENT_AREA = 4;

/** Fewer components than this crossing one row is not a line of text. */
const MIN_BAND_COMPONENTS = 3;

/** Rows carrying this share of the peak row's components are still the band. */
const BAND_ROW_SHARE = 0.6;

/** A component this much inside the band vertically belongs to the band. */
const BAND_MEMBERSHIP_OVERLAP = 0.5;

/**
 * A horizontal gap wider than this share of the band's height ends a word.
 *
 * THE BAND TEST ALONE IS NOT ENOUGH, and the commonest lockup on earth is why:
 * a mark set to the LEFT of a wordmark and vertically centred on it sits
 * squarely inside the text band, and would be filed as a letter. What it does
 * not share with the letters is spacing — inter-letter gaps run a few percent
 * of cap height, while the optical gap between a mark and the word it leads is
 * a third of the lockup's height or more. Measured on the JiffyApp wordmark,
 * whose mark is NOT beside the text: eight glyphs, widest internal gap 7 px
 * against a band 53 px tall, so this splits nothing that belongs together.
 */
const WORD_GAP_SHARE = 0.35;

/** Single-linkage cluster gap, as a share of the pixmap's short edge. */
const CLUSTER_GAP_SHARE = 0.04;

/** Breathing room around the mark, largest first — see `chooseCrop`. */
const PAD_LADDER = [0.16, 0.12, 0.08, 0.04, 0] as const;

/** Foreign ink a padded crop may admit, as a share of the mark's own ink. */
const PAD_FOREIGN_BUDGET = 0.02;

/** Foreign ink above this share of the mark's own ink disqualifies a cluster. */
const MAX_FOREIGN_SHARE = 0.25;

/** A cluster carrying less than this share of the mark ink is a detail, not the mark. */
const MIN_INK_SHARE = 0.15;

/** A crop this empty would read as a blank tile at 16 px. */
const MIN_CROP_DENSITY = 0.02;

/** A square window into the probe pixmap's pixel space. */
export interface MarkCrop {
  x: number;
  y: number;
  size: number;
  /** The pixmap the coordinates above are expressed in. */
  probeWidth: number;
  probeHeight: number;
}

export interface MarkDerivation {
  /** The chosen window, or `null` when no mark could be separated. */
  crop: MarkCrop | null;
  /** Why no crop was chosen. `null` exactly when `crop` is non-null. */
  reason: string | null;
  /** Components judged to be lettering, and therefore excluded. */
  textComponents: number;
  /** Components left over — the mark candidates. */
  markComponents: number;
  /** The chosen cluster's non-background pixels at probe resolution. */
  markPixels: number;
  /** Non-background pixels inside the crop that belong to something else. */
  foreignPixels: number;
  /**
   * `markPixels / crop area` — the share of the finished favicon that is ink.
   *
   * THIS, NOT `opaquePixels`, IS THE MEASURE THAT DISCRIMINATES. The ink gate
   * counts pixels with alpha > 0, and the JiffyApp logo draws an opaque navy
   * field behind everything, so its 16 px favicon measures a perfect 256/256
   * both before and after this change. Coverage measured 9.3% before and 32.7%
   * after at 32 px. Both numbers are reported; only one of them moved.
   */
  coverage: number;
}

interface Component {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Packed RGB of a pixel, or -1 when it is transparent enough to be background. */
function pixelKey(data: Uint8Array, index: number): number {
  if (data[index + 3]! < ALPHA_FLOOR) return -1;
  return (data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!;
}

/**
 * What counts as background here: the modal colour of the one-pixel border
 * ring, believed only when it is `MIN_BACKGROUND_RING_SHARE` uniform.
 *
 * Reading the ring rather than the whole image on purpose. The modal colour of
 * a logo whose mark is a big solid slab IS that slab, and subtracting it would
 * delete the mark; the border is the one place artwork is by convention absent.
 */
function detectBackground(pixmap: Pixmap): number | null {
  const { width, height, data } = pixmap;
  if (width === 0 || height === 0) return null;
  const counts = new Map<number, number>();
  const bump = (x: number, y: number): void => {
    const key = pixelKey(data, (y * width + x) * 4);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < width; x++) {
    bump(x, 0);
    if (height > 1) bump(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    bump(0, y);
    if (width > 1) bump(width - 1, y);
  }
  let bestKey = -1;
  let bestCount = 0;
  let total = 0;
  for (const [key, count] of counts) {
    total += count;
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  if (bestKey < 0 || total === 0) return null;
  return bestCount / total >= MIN_BACKGROUND_RING_SHARE ? bestKey : null;
}

/** 1 where the pixel is artwork, 0 where it is background. */
function foregroundMask(pixmap: Pixmap, background: number | null): Uint8Array {
  const { width, height, data } = pixmap;
  const mask = new Uint8Array(width * height);
  const bgR = background === null ? 0 : (background >> 16) & 0xff;
  const bgG = background === null ? 0 : (background >> 8) & 0xff;
  const bgB = background === null ? 0 : background & 0xff;
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    if (data[i + 3]! < ALPHA_FLOOR) continue;
    if (
      background !== null &&
      Math.abs(data[i]! - bgR) <= BACKGROUND_TOLERANCE &&
      Math.abs(data[i + 1]! - bgG) <= BACKGROUND_TOLERANCE &&
      Math.abs(data[i + 2]! - bgB) <= BACKGROUND_TOLERANCE
    ) {
      continue;
    }
    mask[p] = 1;
  }
  return mask;
}

/**
 * 8-connected components, labelled in place.
 *
 * Explicit stack, never recursion: a solid mark filling a 512x512 probe is a
 * quarter of a million pixels deep, and a recursive flood fill would blow the
 * stack on exactly the artwork that is easiest to draw.
 */
function labelComponents(
  mask: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; components: Component[] } {
  const labels = new Int32Array(width * height).fill(-1);
  const components: Component[] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] !== 1 || labels[seed] !== -1) continue;
    const id = components.length;
    const component: Component = { id, x0: width, y0: height, x1: -1, y1: -1, area: 0 };
    labels[seed] = id;
    stack.push(seed);
    while (stack.length > 0) {
      const p = stack.pop()!;
      const px = p % width;
      const py = (p / width) | 0;
      component.area++;
      if (px < component.x0) component.x0 = px;
      if (py < component.y0) component.y0 = py;
      if (px > component.x1) component.x1 = px;
      if (py > component.y1) component.y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (mask[n] === 1 && labels[n] === -1) {
            labels[n] = id;
            stack.push(n);
          }
        }
      }
    }
    components.push(component);
  }
  return { labels, components };
}

/**
 * Which components are lettering. Two signals, and both are needed.
 *
 * ONE — THE BAND. The property all type has and marks do not is many
 * components sitting on one horizontal band. So count, for every row, how many
 * components cross it; the bands are the runs of rows carrying at least
 * `BAND_ROW_SHARE` of the busiest row's count, and a component inside one for
 * at least `BAND_MEMBERSHIP_OVERLAP` of its own height is a member of it.
 *
 * EVERY SUCH BAND IS A CANDIDATE, AND THE ONE EXPLAINING THE MOST COMPONENTS
 * WINS. Taking the single busiest row and growing one band around it is what
 * an earlier version did, and a live re-run refuted it: on a fresh
 * Vectorizer.ai trace of the JiffyApp lockup the row through the rocket's fins
 * was crossed by 8 components and so was the row through the wordmark — an
 * exact tie, and "first row wins" handed the band to three rocket fragments.
 * The wordmark then became a mark candidate and the derived "mark" read back
 * as the whole brand name.
 *
 * THE THRESHOLD IS GLOBAL, NOT PER-BAND, and that is load-bearing rather than
 * incidental. Deriving it from each candidate's own anchor row instead — also
 * measured, on the same logo — lets a sparse anchor set a threshold of 3, grow
 * a band spanning the entire artwork, and "explain" 15 of 20 components by
 * swallowing the marks along with the letters. Scoring bands against a single
 * fixed bar is what stops the objective rewarding the degenerate answer.
 *
 * Deliberately NOT a per-component height/aspect heuristic: an "l" and an "O"
 * share no aspect ratio, and the dot over an "i" shares nothing with either.
 * What they share is the band.
 *
 * TWO — THE WORD RUN. Band membership alone would file a mark set beside the
 * wordmark as a letter, because that is where such a mark sits. Band members
 * are therefore walked left to right and split wherever the horizontal gap
 * exceeds `WORD_GAP_SHARE` of the band's height; only runs of at least
 * `MIN_BAND_COMPONENTS` are lettering. A mark leading a wordmark is a run of
 * one, and falls out.
 *
 * Measured on the JiffyApp lockup: the winning band is rows 238-290 with 8
 * members, one unbroken run of the eight glyphs of "Jiffyapp" — while the
 * rocket, the bolt and all seven sparkles never enter it.
 */
function findTextComponents(components: Component[], height: number): Component[] {
  if (components.length < MIN_BAND_COMPONENTS) return [];
  const rowCount = new Int32Array(height);
  for (const c of components) {
    for (let y = c.y0; y <= c.y1; y++) rowCount[y]!++;
  }

  const membersOf = (top: number, bottom: number): Component[] =>
    components.filter((c) => {
      const overlap = Math.min(c.y1, bottom) - Math.max(c.y0, top) + 1;
      return overlap > 0 && overlap / (c.y1 - c.y0 + 1) >= BAND_MEMBERSHIP_OVERLAP;
    });

  let peak = 0;
  for (let y = 0; y < height; y++) {
    if (rowCount[y]! > peak) peak = rowCount[y]!;
  }
  if (peak < MIN_BAND_COMPONENTS) return [];
  const threshold = Math.max(MIN_BAND_COMPONENTS, Math.ceil(peak * BAND_ROW_SHARE));

  let band: { members: Component[]; ink: number; height: number } | null = null;
  for (let y = 0; y < height; ) {
    if (rowCount[y]! < threshold) {
      y++;
      continue;
    }
    const top = y;
    while (y < height && rowCount[y]! >= threshold) y++;
    const members = membersOf(top, y - 1);
    if (members.length < MIN_BAND_COMPONENTS) continue;
    const ink = members.reduce((sum, c) => sum + c.area, 0);
    // Most components explained; ties to the one carrying more ink, because
    // eight glyphs outweigh eight stray fragments by an order of magnitude.
    if (
      band === null ||
      members.length > band.members.length ||
      (members.length === band.members.length && ink > band.ink)
    ) {
      band = { members, ink, height: y - top };
    }
  }
  if (band === null) return [];

  const breakGap = Math.max(2, Math.round(band.height * WORD_GAP_SHARE));
  const ordered = [...band.members].sort((a, b) => a.x0 - b.x0);
  const text: Component[] = [];
  let run: Component[] = [];
  // `reach` is the run's running right edge, not the previous member's: a tall
  // glyph that a following one tucks under (a "y" and its neighbour) must not
  // read as a gap, and an overlap must never read as a negative one.
  let reach = -Infinity;
  const flush = (): void => {
    // A run of two is two shapes that happen to line up, not a word. Calling
    // them text would delete half a mark from the candidate set.
    if (run.length >= MIN_BAND_COMPONENTS) text.push(...run);
    run = [];
  };
  for (const c of ordered) {
    if (run.length > 0 && c.x0 - reach > breakGap) flush();
    run.push(c);
    reach = Math.max(reach, c.x1);
  }
  flush();
  return text;
}

/** Gap between two boxes: 0 when they touch or overlap. */
function boxGap(a: Component, b: Component): number {
  const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
  const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
  return Math.hypot(dx, dy);
}

/** Single-linkage clusters over bounding-box gaps (union-find). */
function clusterByProximity(components: Component[], maxGap: number): Component[][] {
  const parent = components.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    let walk = i;
    while (parent[walk] !== root) {
      const next = parent[walk]!;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      if (boxGap(components[i]!, components[j]!) <= maxGap) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Component[]>();
  components.forEach((component, i) => {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(component);
    else groups.set(root, [component]);
  });
  return [...groups.values()];
}

/** Summed-area table over a 0/1 mask, for O(1) rectangle sums. */
function integralImage(mask: Uint8Array, width: number, height: number): Int32Array {
  const stride = width + 1;
  const table = new Int32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += mask[y * width + x]!;
      table[(y + 1) * stride + x + 1] = table[y * stride + x + 1]! + rowSum;
    }
  }
  return table;
}

function rectSum(table: Int32Array, width: number, x: number, y: number, size: number): number {
  const stride = width + 1;
  return (
    table[(y + size) * stride + x + size]! -
    table[y * stride + x + size]! -
    table[(y + size) * stride + x]! +
    table[y * stride + x]!
  );
}

interface Candidate {
  crop: MarkCrop;
  markPixels: number;
  foreignPixels: number;
  coverage: number;
}

/**
 * The square window for one cluster: as much breathing room as the artwork
 * allows, positioned where it admits the least of everything else.
 *
 * BOTH HALVES ARE MEASURED, AND BOTH ARE NEEDED. The JiffyApp rocket sits
 * directly above the "i" of "Jiffyapp", between the "J" and the first "f", so
 * a naively centred square crop of it clips two white letterforms into its
 * bottom corners — visible at 512 px and grubby at 32. Sliding the window
 * inside the freedom the padding buys drops the foreign ink from 82 px to 0,
 * and shrinking the padding when even the best position cannot get under
 * budget is what makes that possible: measured for that rocket, the ladder
 * lands on pad 0 with 0 foreign pixels, where pad 0.12 could do no better than
 * 82 (21% of the mark's own ink).
 */
function chooseCrop(
  cluster: Component[],
  labels: Int32Array,
  inkTable: Int32Array,
  width: number,
  height: number,
): Candidate | null {
  const ids = new Set(cluster.map((c) => c.id));
  const ownMask = new Uint8Array(width * height);
  for (let p = 0; p < ownMask.length; p++) {
    const label = labels[p]!;
    if (label >= 0 && ids.has(label)) ownMask[p] = 1;
  }
  const ownTable = integralImage(ownMask, width, height);

  const x0 = Math.min(...cluster.map((c) => c.x0));
  const y0 = Math.min(...cluster.map((c) => c.y0));
  const x1 = Math.max(...cluster.map((c) => c.x1));
  const y1 = Math.max(...cluster.map((c) => c.y1));
  const base = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  const limit = Math.min(width, height);

  let fallback: Candidate | null = null;
  for (const pad of PAD_LADDER) {
    const size = Math.max(1, Math.min(limit, Math.round(base * (1 + 2 * pad))));
    // Every offset that still contains the cluster box, clamped into the
    // pixmap. `Math.min(hi, ...)`/`Math.max(lo, ...)` keeps lo <= hi even when
    // the cluster is larger than the (clamped) window.
    const xLo = Math.max(0, Math.min(width - size, x1 - size + 1));
    const xHi = Math.max(xLo, Math.min(width - size, x0));
    const yLo = Math.max(0, Math.min(height - size, y1 - size + 1));
    const yHi = Math.max(yLo, Math.min(height - size, y0));
    const centredX = (x0 + x1) / 2 - size / 2;
    const centredY = (y0 + y1) / 2 - size / 2;

    let best: Candidate | null = null;
    let bestDistance = Infinity;
    for (let x = xLo; x <= xHi; x++) {
      for (let y = yLo; y <= yHi; y++) {
        const own = rectSum(ownTable, width, x, y, size);
        const foreign = rectSum(inkTable, width, x, y, size) - own;
        const distance = Math.hypot(x - centredX, y - centredY);
        if (
          best === null ||
          foreign < best.foreignPixels ||
          (foreign === best.foreignPixels && distance < bestDistance)
        ) {
          best = {
            crop: { x, y, size, probeWidth: width, probeHeight: height },
            markPixels: own,
            foreignPixels: foreign,
            coverage: own / (size * size),
          };
          bestDistance = distance;
        }
      }
    }
    if (best === null) continue;
    fallback = best; // the ladder descends, so this ends on the tightest crop
    if (best.foreignPixels <= best.markPixels * PAD_FOREIGN_BUDGET) return best;
  }
  // Even the tightest crop could not shake the neighbours off: this cluster is
  // interlocked with the rest of the artwork and is not a separable mark.
  if (fallback !== null && fallback.foreignPixels > fallback.markPixels * MAX_FOREIGN_SHARE) {
    return null;
  }
  return fallback;
}

/**
 * Find the logo's pictorial mark. Never throws; a logo it cannot read yields
 * `crop: null` and a reason, which is `buildPack`'s cue to keep today's
 * whole-logo behaviour.
 */
export async function deriveFaviconMark(
  svg: string,
  sources: WasmSources,
): Promise<MarkDerivation> {
  const empty = (reason: string): MarkDerivation => ({
    crop: null,
    reason,
    textComponents: 0,
    markComponents: 0,
    markPixels: 0,
    foreignPixels: 0,
    coverage: 0,
  });

  let pixmap: Pixmap;
  try {
    pixmap = await renderSvgToPixmap(svg, MARK_PROBE_PX, sources);
  } catch (err) {
    return empty(`the logo could not be rendered for analysis: ${errorText(err)}`);
  }
  const { width, height } = pixmap;
  if (width < 2 || height < 2) return empty('the logo rendered too small to analyse');

  const background = detectBackground(pixmap);
  const mask = foregroundMask(pixmap, background);
  const { labels, components: raw } = labelComponents(mask, width, height);
  const components = raw.filter((c) => c.area >= MIN_COMPONENT_AREA);
  if (components.length === 0) return empty('the logo rendered no artwork to analyse');
  // Built from the FULL foreground mask, specks included. A speck is too small
  // to be a mark but is still ink that would show up in a crop, so it has to
  // count as foreign when the window is positioned.
  const inkTable = integralImage(mask, width, height);

  const text = findTextComponents(components, height);
  const textIds = new Set(text.map((c) => c.id));
  const markComponents = components.filter((c) => !textIds.has(c.id));
  if (markComponents.length === 0) {
    return {
      ...empty('every element of this logo is lettering — there is no separate mark to crop'),
      textComponents: text.length,
    };
  }

  const totalMarkInk = markComponents.reduce((sum, c) => sum + c.area, 0);
  const clusters = clusterByProximity(
    markComponents,
    Math.round(CLUSTER_GAP_SHARE * Math.min(width, height)),
  );

  let winner: Candidate | null = null;
  for (const cluster of clusters) {
    const clusterInk = cluster.reduce((sum, c) => sum + c.area, 0);
    // A stray sparkle is a detail of the artwork, not the artwork's mark.
    if (clusterInk < totalMarkInk * MIN_INK_SHARE) continue;
    const candidate = chooseCrop(cluster, labels, inkTable, width, height);
    if (candidate === null || candidate.coverage < MIN_CROP_DENSITY) continue;
    // Densest wins: coverage is literally "how much of the finished favicon is
    // ink", which is the property a 16 px icon lives or dies by. It is why the
    // JiffyApp rocket (0.32) is preferred to the larger but airier
    // bolt-and-sparkles cluster (0.06).
    if (winner === null || candidate.coverage > winner.coverage) winner = candidate;
  }
  if (winner === null) {
    return {
      ...empty('no mark candidate was compact or solid enough to read at 16 px'),
      textComponents: text.length,
      markComponents: markComponents.length,
    };
  }
  return {
    crop: winner.crop,
    reason: null,
    textComponents: text.length,
    markComponents: markComponents.length,
    markPixels: winner.markPixels,
    foreignPixels: winner.foreignPixels,
    coverage: winner.coverage,
  };
}

/** base64 for Workers (no Buffer): chunked to stay under the spread-arg limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * A square SVG showing only `crop` of `svg`, at any size resvg is asked for.
 *
 * The crop is expressed as the OUTER viewBox over an `<image>` laid out at the
 * probe pixmap's dimensions, so the geometry above — which is measured in
 * probe pixels — transfers without a coordinate conversion and without this
 * module having to parse the source's own `viewBox`/`width`/`height` (which
 * may be absent, percentage-valued, or carry a `preserveAspectRatio` of its
 * own). Everything outside the viewBox is clipped by the root viewport.
 *
 * STILL A TRUE VECTOR RENDER. resvg parses a referenced `image/svg+xml` data
 * URI into its own tree rather than rasterising it at a fixed intermediate
 * size — the property `faviconPack.ts`'s `squareSvgWrapper` already relies on
 * — so `favicon-16.png` is drawn at 16 px from paths, not squeezed out of a
 * bigger raster. The wrapper is never delivered: `logo.svg` in the pack is the
 * untouched source, and the true-vector gate would reject this `<image>` on
 * sight, which is exactly why only PNGs come out of here.
 *
 * The source is UTF-8 encoded before base64 because `btoa` throws above
 * U+00FF, and a logo carrying a non-Latin `<title>` is legitimate input.
 */
export function cropSvg(svg: string, crop: MarkCrop): string {
  const encoded = toBase64(new TextEncoder().encode(svg));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${crop.size}" height="${crop.size}" ` +
    `viewBox="${crop.x} ${crop.y} ${crop.size} ${crop.size}">` +
    `<image width="${crop.probeWidth}" height="${crop.probeHeight}" ` +
    `preserveAspectRatio="xMidYMid meet" href="data:image/svg+xml;base64,${encoded}"/>` +
    `</svg>`
  );
}
