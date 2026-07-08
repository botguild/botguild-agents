// ---------------------------------------------------------------------------
// Editable-template gate (PRD §9, US-1 AC3): the deliverable must carry the
// Satori JSX/JSON layout source, openable without any vendor account, and it
// must parse. A vendor-account-resident template does not satisfy this gate.
//
// The artifact is the serialized layout descriptor + the element tree the
// render produced — pure JSON, which is exactly what makes it editable.
// ---------------------------------------------------------------------------

import type { BrandKit, JobInputs, Rect, SwatchRegion } from '../types.js';
import type { LayoutDescriptor, SatoriNode } from '../layouts/types.js';

export const TEMPLATE_VERSION = 'thumbforge-template-v1';

export interface TemplateArtifact {
  version: string;
  templateId: string;
  format: string;
  width: number;
  height: number;
  safeZone: Rect;
  logoRect: Rect;
  swatchRegions: SwatchRegion[];
  minFontPx: number;
  headlineFontPx: number;
  /** The Satori element tree in object form — the editable layout source. */
  element: SatoriNode;
}

/** Build the editable-template artifact JSON for a layout + job. */
export function serializeTemplate(
  layout: LayoutDescriptor,
  brandKit: BrandKit,
  inputs: JobInputs,
): string {
  const rendered = layout.render(brandKit, inputs);
  const artifact: TemplateArtifact = {
    version: TEMPLATE_VERSION,
    templateId: layout.templateId,
    format: layout.format,
    width: layout.width,
    height: layout.height,
    safeZone: layout.safeZone,
    logoRect: layout.logoRect,
    swatchRegions: layout.swatchRegions,
    minFontPx: layout.minFontPx,
    headlineFontPx: rendered.headlineFontPx,
    element: rendered.element,
  };
  return JSON.stringify(artifact, null, 2);
}

export interface TemplateCheckResult {
  pass: boolean;
  error?: string;
  parsed?: TemplateArtifact;
}

/** Assert the template artifact is present and parses into a usable layout source. */
export function checkTemplate(artifact: string | undefined | null): TemplateCheckResult {
  if (!artifact || artifact.trim().length === 0) {
    return { pass: false, error: 'template artifact is absent' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact);
  } catch (err) {
    return { pass: false, error: `template artifact does not parse: ${(err as Error).message}` };
  }
  const t = parsed as Partial<TemplateArtifact>;
  if (typeof t.templateId !== 'string' || t.templateId.length === 0) {
    return { pass: false, error: 'template artifact has no templateId' };
  }
  if (typeof t.width !== 'number' || typeof t.height !== 'number') {
    return { pass: false, error: 'template artifact has no dimensions' };
  }
  if (
    !t.element ||
    typeof t.element !== 'object' ||
    typeof (t.element as SatoriNode).type !== 'string'
  ) {
    return { pass: false, error: 'template artifact has no element tree' };
  }
  return { pass: true, parsed: parsed as TemplateArtifact };
}
