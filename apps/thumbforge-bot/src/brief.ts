// ---------------------------------------------------------------------------
// Per-job brief parsing (PRD §8 input brief) + the render-plan builder.
//
// A gig description embeds the §8 JSON brief (a fenced ```json block or the raw
// description). We parse it leniently into a BrandKit + per-kind inputs, then
// build a fully-resolved RenderPlan (one GraphicSpec per output graphic) that
// the queue consumer renders without any further fetch. Pure — no globals.
// ---------------------------------------------------------------------------

import type { GraphicSpec, RenderKind, RenderPlan } from './jobs.js';
import { og, socialFeed, socialStory, thumbnailA, thumbnailB } from './layouts/index.js';
import type { BrandKit, JobInputs, Rect, SwatchRegion } from './types.js';

export interface ParsedBrief {
  jobType: RenderKind | 'og';
  brandKit: BrandKit;
  og?: { title: string; pageUrl: string };
  thumbnail?: { videoId?: string; headline?: string };
  socialPack?: { copy: string[]; count: number; formats: string[] };
}

const DEFAULT_PALETTE = ['#0F1E3C', '#FF6B5E', '#F5C518'];

function rectFromArray(value: unknown): Rect | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [x, y, width, height] = value.map(Number);
  if ([x, y, width, height].some((n) => !Number.isFinite(n))) return null;
  return { x, y, width, height };
}

function parseBrandKit(raw: unknown): BrandKit {
  const kit = (raw ?? {}) as Record<string, unknown>;
  const palette =
    Array.isArray(kit.palette) && kit.palette.length > 0
      ? (kit.palette as unknown[]).map(String)
      : DEFAULT_PALETTE;
  const swatchRegions: SwatchRegion[] = Array.isArray(kit.swatch_regions)
    ? (kit.swatch_regions as unknown[])
        .map((entry) => {
          const e = entry as Record<string, unknown>;
          const rect = rectFromArray(e.rect);
          return rect && typeof e.role === 'string' ? { role: e.role, rect } : null;
        })
        .filter((r): r is SwatchRegion => r !== null)
    : [];
  return { palette, swatchRegions };
}

/** Extract the first fenced ```json block, else the whole string. */
function extractJson(description: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(description);
  return (fenced?.[1] ?? description).trim();
}

/** Parse a §8 brief from a gig description. Returns null when no JSON is present. */
export function parseBrief(description: string): ParsedBrief | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJson(description)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const jobTypeRaw = String(parsed.job_type ?? '');
  const jobType: ParsedBrief['jobType'] =
    jobTypeRaw === 'og' ? 'og' : jobTypeRaw === 'thumbnail' ? 'thumbnail' : 'social_pack';
  const brandKit = parseBrandKit(parsed.brand_kit);

  const brief: ParsedBrief = { jobType, brandKit };

  const ogRaw = parsed.og as Record<string, unknown> | undefined;
  if (ogRaw) brief.og = { title: String(ogRaw.title ?? ''), pageUrl: String(ogRaw.page_url ?? '') };

  const thumbRaw = parsed.thumbnail as Record<string, unknown> | undefined;
  if (thumbRaw) {
    brief.thumbnail = {
      videoId: thumbRaw.video_id ? String(thumbRaw.video_id) : undefined,
      headline: thumbRaw.headline ? String(thumbRaw.headline) : undefined,
    };
  }

  const packRaw = parsed.social_pack as Record<string, unknown> | undefined;
  if (packRaw) {
    const copy = Array.isArray(packRaw.copy) ? (packRaw.copy as unknown[]).map(String) : [];
    const formats = Array.isArray(packRaw.formats)
      ? (packRaw.formats as unknown[]).map(String)
      : ['feed', 'story'];
    const count = Number(packRaw.count);
    brief.socialPack = {
      copy,
      formats: formats.length > 0 ? formats : ['feed', 'story'],
      count: Number.isFinite(count) && count > 0 ? Math.floor(count) : Math.max(copy.length, 1),
    };
  }

  return brief;
}

/** The two layout-distinct thumbnail variants (§9 A/B). */
export function buildThumbnailPlan(brandKit: BrandKit, headline: string): RenderPlan {
  const inputs: JobInputs = { headline };
  const graphics: GraphicSpec[] = [thumbnailA, thumbnailB].map((layout, i) => ({
    graphicId: `variant-${String.fromCharCode(97 + i)}`,
    templateId: layout.templateId,
    format: layout.format,
    brandKit,
    inputs,
  }));
  return { kind: 'thumbnail', graphics };
}

/** The contracted social-pack count across feed (1080²) + story (1080×1920). */
export function buildSocialPackPlan(
  brandKit: BrandKit,
  pack: NonNullable<ParsedBrief['socialPack']>,
): RenderPlan {
  const graphics: GraphicSpec[] = [];
  for (let i = 0; i < pack.count; i++) {
    const format = pack.formats[i % pack.formats.length] === 'story' ? 'story' : 'feed';
    const layout = format === 'story' ? socialStory : socialFeed;
    const headline =
      pack.copy.length > 0 ? (pack.copy[i % pack.copy.length] as string) : `Graphic ${i + 1}`;
    graphics.push({
      graphicId: `g${i + 1}`,
      templateId: layout.templateId,
      format: layout.format,
      brandKit,
      inputs: { headline },
    });
  }
  return { kind: 'social_pack', graphics };
}

/** Build the OG single-graphic spec (used on both sync and re-drive paths). */
export function buildOgGraphic(brandKit: BrandKit, title: string, graphicId: string): GraphicSpec {
  return {
    graphicId,
    templateId: og.templateId,
    format: og.format,
    brandKit,
    inputs: { headline: title, title },
  };
}
