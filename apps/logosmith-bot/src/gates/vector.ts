// ---------------------------------------------------------------------------
// True-vector gate (FR-10, §9) — the gate that makes "true vector" a verified
// property rather than a vendor claim. The delivered logo.svg must parse with
// ONLY vector primitives:
//
//   zero <image>           — an SVG wrapping a raster is the exact fraud the
//                            buyer fears; it fails, full stop
//   zero raster hrefs      — data:image/... or .png/.jpg refs anywhere
//   zero external refs     — url()/href/xlink:href to an outside origin, in
//                            ANY form: a raw <use>/gradient href, CSS
//                            `style="...url(https://...)"`, or one that only
//                            existed as a <style> block before an optimizer
//                            inlined it onto an allowed element and deleted
//                            the tag. A same-document `#id` fragment is not
//                            an external reference and is unaffected.
//   no <text>              — outlined paths only, which also guarantees the
//                            renderer never needs to load a font
//   no <foreignObject>     — arbitrary HTML inside an SVG
//   no <script>/on* attrs  — stripped defensively by sanitizeSvg first
//   viewBox present AND    — presence alone is not enough: "bogus" parses as
//   parseable as 4 numbers   zero errors and ships a mark that silently
//                            mis-scales, so the value itself is validated.
//
// Workers has no DOM, and a full XML parser is bundle weight the §13 size
// budget cannot spare, so this is a conservative tag/attribute scan: anything
// not positively classified as a vector primitive counts as a violation.
//
// NOTE: We do not handle malformed XML with whitespace-after-< (e.g., "< script>").
// No compliant XML/HTML parser treats this as a start tag, so it is out of scope.
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

// Any reference to an external origin, in either form it can arrive:
//   - `href="https://..."` / `href='//...'` — the `\b` before `href` matches
//     equally well when it's actually `xlink:href`, because a word boundary
//     sits between the `:` and the `h` exactly as it does before a bare
//     `href`; no separate `xlink:` alternative is needed.
//   - `url(https://...)` / `url(//...)` — the CSS functional form, reachable
//     via any `style="..."` attribute on any allowed element, not only from
//     inside a `<style>` block.
// A same-document fragment (`href="#id"`, `url(#id)`) never matches: once the
// optional `(?:https?:)?` scheme is consumed (or skipped), the mandatory
// `\/\/` still has to follow, and `#id` does not start with `//`.
const EXTERNAL_REF_RE = /\bhref\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\//i;

// viewBox's VALUE, not just its presence — "bogus" or "1 2 3" (three, not
// four, numbers) must not satisfy the gate. SVG allows either whitespace or
// commas (or both) between the four numbers.
const VIEWBOX_ATTR_RE = /\sviewBox\s*=\s*(["'])([^"']*)\1/; // case-sensitive, matches XML's own rule
const VIEWBOX_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function isValidViewBox(value: string): boolean {
  const tokens = value
    .trim()
    .split(/[\s,]+/)
    .filter((token) => token.length > 0);
  return tokens.length === 4 && tokens.every((token) => VIEWBOX_NUMBER_RE.test(token));
}

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
      // Metadata: strip entire metadata subtrees (namespace-aware) to prevent false
      // rejections of vendor metadata like <rdf:RDF> nested inside <metadata>.
      // SVGO does this in the real pipeline.
      .replace(/<(?:[\w.-]+:)?metadata\b[\s\S]*?<\/(?:[\w.-]+:)?metadata\s*>/gi, '')
      .replace(/<(?:[\w.-]+:)?metadata\b[^>]*\/>/gi, '')
      // Event attributes: remove on* handlers
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
  );
}

/** Assert the SVG contains only vector primitives (FR-10). */
export function checkTrueVector(svg: string): VectorGateResult {
  const viewBoxMatch = svg.match(VIEWBOX_ATTR_RE);
  const census: NodeCensus = {
    path: countTag(svg, 'path'),
    shape: SHAPE_TAGS.reduce((sum, tag) => sum + countTag(svg, tag), 0),
    image: countTag(svg, 'image'),
    text: countTag(svg, 'text') + countTag(svg, 'tspan'),
    foreignObject: countTag(svg, 'foreignObject'),
    script: countTag(svg, 'script'),
    hasViewBox: viewBoxMatch !== null && isValidViewBox(viewBoxMatch[2]),
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
  if (EXTERNAL_REF_RE.test(svg)) {
    violations.push('contains an external reference (url()/href to an outside origin)');
  }

  // Allowlist check: every opening tag must be in the vector allowlist.
  // This catches namespace-prefixed dangerous elements and any unrecognized
  // tags. Deliberately excludes <style> (CSS can smuggle url(...) — an
  // optimizer inlining a <style> rule onto an allowed element's own
  // `style="..."` attribute does NOT defeat this protection, because
  // EXTERNAL_REF_RE above scans the whole document for that exact pattern,
  // not just <style> blocks) and <a> (facilitates javascript: bypass).
  // Regex captures optional namespace prefix: <(prefix:)?localName
  const tagMatches = svg.matchAll(/<([\w.-]+(?::[\w.-]+)?)(?=[\s/>])/g);
  for (const match of tagMatches) {
    const fullTag = match[1];
    // Strip namespace prefix if present (e.g., "ns1:script" → "script", "ns2:style" → "style")
    const tag = fullTag.includes(':') ? fullTag.split(':')[1] : fullTag;
    const tagLower = tag.toLowerCase();

    if (!VECTOR_ALLOWLIST.has(tagLower)) {
      violations.push(`contains a non-vector element: <${fullTag}>`);
    }
  }

  if (!census.hasViewBox) violations.push('missing or invalid viewBox');
  if (census.path + census.shape === 0) violations.push('contains no vector primitives at all');

  return { pass: violations.length === 0, violations, census };
}
