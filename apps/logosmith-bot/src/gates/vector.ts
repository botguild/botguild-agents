// ---------------------------------------------------------------------------
// True-vector gate (FR-10, §9) — the gate that makes "true vector" a verified
// property rather than a vendor claim. The delivered logo.svg must parse with
// ONLY vector primitives:
//
//   zero <image>           — an SVG wrapping a raster is the exact fraud the
//                            buyer fears; it fails, full stop
//   zero raster hrefs      — data:image/... or .png/.jpg refs anywhere
//   references are         — every href/xlink:href/url() value must
//   fragment-only            normalize to a pure `#id` — nothing else is
//                            allow-listed. This is deliberately NOT "detect
//                            the bad schemes": the WHATWG URL Standard makes
//                            enumerating bad schemes unwinnable (the six
//                            "special" schemes, incl. http/https, need no
//                            "//" at all — "https:evil.example.com" parses
//                            to "https://evil.example.com"; the parser's own
//                            first step strips ASCII tab/newline from
//                            ANYWHERE in the input, so "h<TAB>ttps://…"
//                            parses identically to "https://…"). A regex
//                            approximating a URL parser always loses to the
//                            URL parser, so this allow-lists the one
//                            legitimate FORM instead of blocking bad ones.
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

// Every place a reference VALUE can appear:
//   - `href="..."` / `href='...'` — the `\b` before `href` matches equally
//     well when it's actually `xlink:href`, because a word boundary sits
//     between the `:` and the `h` exactly as it does before a bare `href`;
//     no separate `xlink:` alternative is needed. The backreference `\1`
//     (not a plain `[^"']*`) is deliberate: it matches up to the SPECIFIC
//     quote character that opened the attribute, so a value legitimately
//     containing the other quote character is captured whole rather than
//     truncated early.
//   - `url(...)` — the CSS functional form, reachable via any `style="..."`
//     attribute on any allowed element or inside a raw `<style>` block; this
//     scans the WHOLE document string for it, so both are covered by the
//     same match regardless of which XML structure wraps it.
// Neither regex judges the captured value itself — normalizeRef() and
// isPureFragment() below do that. Extraction only finds the candidates.
//
// BOTH ARE SCANNED WITH A REWINDING `exec` LOOP, NEVER `matchAll` — see
// `anyNonFragmentRef` below, where that is the whole point. The trailing `)`
// on URL_FN_RE is likewise OPTIONAL on purpose: CSS's "consume a url token"
// step returns the <url-token> at EOF, so `style="fill:url(https://evil…"`
// with no `)` anywhere is a reference a renderer follows, and a required `)`
// produced no match at all.
const HREF_ATTR_RE = /\bhref\s*=\s*(["'])((?:(?!\1)[\s\S])*)\1/gi;
const URL_FN_RE = /url\(([^)]*)\)?/gi;

/**
 * Reproduces the WHATWG URL Standard's own first two input-preprocessing
 * steps, because those are exactly what makes a bad-scheme blocklist
 * unwinnable: (1) "remove all ASCII tab or newline from input" — a global
 * strip, wherever they occur, not a trim, which is what lets
 * "h<TAB>ttps://evil" parse identically to "https://evil"; (2) trim any
 * remaining leading/trailing whitespace. A third step specific to THIS
 * gate's callers (not the URL Standard): strip one layer of CSS/XML quoting
 * a `url(...)` capture may still carry — an `href` capture never does, since
 * `HREF_ATTR_RE` already excludes its own delimiter quotes, so this is a
 * no-op there.
 */
function normalizeRef(raw: string): string {
  const withoutTabsOrNewlines = raw.replace(/[\t\n\r]/g, '');
  const trimmed = withoutTabsOrNewlines.trim();
  const isQuoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")));
  return (isQuoted ? trimmed.slice(1, -1) : trimmed).trim();
}

/**
 * The ONLY legitimate reference in a delivered, standalone SVG: a
 * same-document fragment. Deliberately rejects everything else, including
 * relative file paths (`foo.svg#x`) — a logo that depends on a neighbouring
 * file is broken the moment the customer moves it, so that is not collateral
 * damage, it is correct.
 */
const isPureFragment = (value: string): boolean =>
  value.startsWith('#') && value.indexOf('#', 1) === -1;

/**
 * Scan every occurrence of `pattern` INDEPENDENTLY and report whether any
 * captured reference is not a pure fragment.
 *
 * A PLAIN `matchAll` IS UNSOUND HERE, AND THE FAILURE IS A SKIPPED CAPTURE
 * RATHER THAN AN INACCURATE ONE. Both extraction regexes CONSUME what they
 * match, and `matchAll` resumes after the whole match — so one greedy,
 * unterminated reference swallows the document up to its next delimiter and
 * every reference inside that span is NEVER EXAMINED AT ALL. The swallowing
 * capture begins with `#`, reads as a pure fragment, and the gate passes.
 *
 * Measured, both shapes, on documents that are ordinary well-formed XML:
 *
 *   fill="url(#g" clip-path="url(https://evil.example.com/x)"        passed
 *   fill="url(#g"/><rect fill="url(https://evil.example.com/x)"/>    passed
 *   <desc>href="#g</desc><use href="https://evil.example.com/x.svg"/> passed
 *
 * The third one needs no malformed markup at all: `<desc>`/`<title>` are
 * allow-listed, their TEXT may legally contain a raw quote, and one unmatched
 * quote re-pairs every quote after it. `sanitizeSvg` does not strip them.
 * `url(#g` at end-of-input is likewise a valid CSS <url-token>. So a renderer
 * paints one fragment and FETCHES ONE EXTERNAL URL from the paid logo.svg —
 * the impact Task 20's Critical 1 closed.
 *
 * NOTE FOR WHOEVER READS THE LEDGER: the Task 20 invariant ("the captured value
 * is a prefix of the real value, so a `#` prefix means the real value is a
 * fragment") is TRUE and is not what was broken. It reasons about the fidelity
 * of a capture that WAS taken. `url(#g href='https://…')` still legitimately
 * passes, because that whole value really is a same-document fragment.
 *
 * The fix is to rewind `lastIndex` to just past the match's own INTRODUCER
 * (`url(` / `href`), so every occurrence gets its own scan and none can hide
 * behind an earlier one.
 *
 * THIS STAYS LINEAR, and that matters because `freeGigs.ts` hands this gate a
 * buyer-supplied SVG of up to 10 MB. The loop stops at the first impure
 * capture, and two PURE captures cannot overlap: a pure capture contains
 * exactly one `#`, at its own start, so a later reference beginning inside it
 * could not also begin with `#` unless it began at the same offset. The pure
 * captures therefore partition the document. Measured at 10 MB across three
 * adversarial shapes: 107-302 ms.
 */
function anyNonFragmentRef(svg: string, pattern: RegExp, group: number, rewind: number): boolean {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(svg)) !== null) {
    pattern.lastIndex = match.index + rewind;
    if (!isPureFragment(normalizeRef(match[group] ?? ''))) return true;
  }
  return false;
}

/** True if any href/xlink:href/url() value in the document is not a pure fragment. */
function hasNonFragmentReference(svg: string): boolean {
  // `\bhref` matches at the `h` of a bare `href` AND of `xlink:href` alike, so
  // rewinding past those four characters lands after the introducer in both.
  return (
    anyNonFragmentRef(svg, HREF_ATTR_RE, 2, 'href'.length) ||
    anyNonFragmentRef(svg, URL_FN_RE, 1, 'url('.length)
  );
}

// viewBox's VALUE, not just its presence — "bogus" or "1 2 3" (three, not
// four, numbers) must not satisfy the gate. SVG allows either whitespace or
// commas (or both) between the four numbers.
const VIEWBOX_ATTR_RE = /\sviewBox\s*=\s*(["'])([^"']*)\1/; // case-sensitive, matches XML's own rule
// SVG's own <number> grammar permits an exponent (e.g. "1e2"), so this must
// too — "0 0 1e2 1e2" is a spec-legal viewBox and must not be rejected.
const VIEWBOX_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

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
  if (hasNonFragmentReference(svg)) {
    violations.push(
      'contains a non-fragment reference (external references and relative file paths are ' +
        'not permitted — every href/xlink:href/url() must be a same-document "#id")',
    );
  }

  // Allowlist check: every opening tag must be in the vector allowlist.
  // This catches namespace-prefixed dangerous elements and any unrecognized
  // tags. Deliberately excludes <style> (CSS can smuggle url(...) — an
  // optimizer inlining a <style> rule onto an allowed element's own
  // `style="..."` attribute does NOT defeat this protection, because
  // hasNonFragmentReference() above scans the whole document for that exact
  // pattern, not just <style> blocks) and <a> (facilitates javascript: bypass).
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
