// ---------------------------------------------------------------------------
// True-vector gate (FR-10, §9) — the gate that makes "true vector" a verified
// property rather than a vendor claim. The delivered logo.svg must parse with
// ONLY vector primitives:
//
//   zero <image>           — an SVG wrapping a raster is the exact fraud the
//                            buyer fears; it fails, full stop
//   zero raster hrefs      — data:image/... or .png/.jpg refs anywhere
//   no <text>              — outlined paths only, which also guarantees the
//                            renderer never needs to load a font
//   no <foreignObject>     — arbitrary HTML inside an SVG
//   no <script>/on* attrs  — stripped defensively by sanitizeSvg first
//   viewBox present        — without it the mark does not scale predictably
//
// Workers has no DOM, and a full XML parser is bundle weight the §13 size
// budget cannot spare, so this is a conservative tag/attribute scan: anything
// not positively classified as a vector primitive counts as a violation.
// ---------------------------------------------------------------------------

export interface NodeCensus {
  path: number;
  shape: number;
  image: number;
  text: number;
  foreignObject: number;
  script: number;
  hasViewBox: boolean;
}

export interface VectorGateResult {
  pass: boolean;
  violations: string[];
  census: NodeCensus;
}

const SHAPE_TAGS = ['circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'];
const RASTER_REF_RE = /(?:data:image\/|\.(?:png|jpe?g|gif|webp|bmp|avif)\b)/i;
const EVENT_ATTR_RE = /\son[a-z]+\s*=/i;
const JAVASCRIPT_HREF_RE = /\shref\s*=\s*["']?\s*javascript:/i;

// Allowlist of all recognized vector primitives and metadata elements
const VECTOR_ALLOWLIST = new Set([
  'svg',
  'g',
  'defs',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'clippath',
  'mask',
  'lineargradient',
  'radialgradient',
  'stop',
  'pattern',
  'symbol',
  'use',
  'title',
  'desc',
  'metadata',
]);

const countTag = (svg: string, tag: string): number =>
  (svg.match(new RegExp(`<(?:[\\w.-]+:)?${tag}[\\s/>]`, 'gi')) ?? []).length;

/**
 * Strip the actively dangerous constructs before the gate runs. Sanitization
 * and the gate are deliberately separate: sanitize removes what can be safely
 * removed, the gate then proves what remains is a true vector.
 */
export function sanitizeSvg(svg: string): string {
  return (
    svg
      // Script: both bare and namespace-prefixed forms, paired and self-closing
      .replace(/<(?:[\w.-]+:)?script\b[\s\S]*?<\/(?:[\w.-]+:)?script\s*>/gi, '')
      .replace(/<(?:[\w.-]+:)?script\b[^>]*\/>/gi, '')
      // ForeignObject: both bare and namespace-prefixed forms, paired and self-closing
      .replace(/<(?:[\w.-]+:)?foreignObject\b[\s\S]*?<\/(?:[\w.-]+:)?foreignObject\s*>/gi, '')
      .replace(/<(?:[\w.-]+:)?foreignObject\b[^>]*\/>/gi, '')
      // Event attributes: remove on* handlers
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
  );
}

/** Assert the SVG contains only vector primitives (FR-10). */
export function checkTrueVector(svg: string): VectorGateResult {
  const census: NodeCensus = {
    path: countTag(svg, 'path'),
    shape: SHAPE_TAGS.reduce((sum, tag) => sum + countTag(svg, tag), 0),
    image: countTag(svg, 'image'),
    text: countTag(svg, 'text') + countTag(svg, 'tspan'),
    foreignObject: countTag(svg, 'foreignObject'),
    script: countTag(svg, 'script'),
    hasViewBox: /\sviewBox\s*=/.test(svg), // case-sensitive: XML attribute names are case-sensitive
  };

  const violations: string[] = [];

  // Blocklist checks (specific dangerous patterns)
  if (census.image > 0) violations.push(`contains ${census.image} <image> element(s)`);
  if (census.text > 0) violations.push(`contains ${census.text} <text>/<tspan> element(s)`);
  if (census.foreignObject > 0) violations.push('contains <foreignObject>');
  if (census.script > 0) violations.push('contains <script>');
  if (EVENT_ATTR_RE.test(svg)) violations.push('contains an on* event attribute');
  if (JAVASCRIPT_HREF_RE.test(svg)) violations.push('contains a javascript: href');
  if (RASTER_REF_RE.test(svg)) violations.push('contains a raster reference (data: or image file)');

  // Allowlist check: every opening tag must be in the vector allowlist.
  // This catches namespace-prefixed dangerous elements and any unrecognized tags.
  // Deliberately excludes <style> (can smuggle url(data:...)) and <a> (facilitates javascript: bypass).
  const tagMatches = svg.matchAll(/<([\w.-]+)(?=[\s/>])/g);
  for (const match of tagMatches) {
    const fullTag = match[1];
    // Strip namespace prefix if present (e.g., "ns1:script" → "script")
    const tag = fullTag.includes(':') ? fullTag.split(':')[1] : fullTag;
    const tagLower = tag.toLowerCase();

    if (!VECTOR_ALLOWLIST.has(tagLower)) {
      violations.push(`contains a non-vector element: <${fullTag}>`);
    }
  }

  if (!census.hasViewBox) violations.push('missing viewBox');
  if (census.path + census.shape === 0) violations.push('contains no vector primitives at all');

  return { pass: violations.length === 0, violations, census };
}
