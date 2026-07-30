import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkTrueVector, sanitizeSvg } from './vector.js';

const TRUE_VECTOR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M10 10 H90 V90 H10 Z" fill="#0F3D3E"/>' +
  '<circle cx="50" cy="50" r="20" fill="#E8C39E"/></svg>';

describe('checkTrueVector', () => {
  it('passes a paths-and-shapes-only SVG with a viewBox', () => {
    const result = checkTrueVector(TRUE_VECTOR);
    assert.equal(result.pass, true);
    assert.deepEqual(result.violations, []);
    assert.equal(result.census.path, 1);
    assert.equal(result.census.shape, 1);
    assert.equal(result.census.hasViewBox, true);
  });

  it('fails an SVG that wraps a raster in an <image> element', () => {
    const result = checkTrueVector(
      '<svg viewBox="0 0 10 10"><image href="data:image/png;base64,iVBOR"/></svg>',
    );
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => /image/.test(v)));
  });

  it('fails an SVG with a raster href on any element', () => {
    const result = checkTrueVector(
      '<svg viewBox="0 0 10 10"><path d="M0 0" fill="url(data:image/png;base64,x)"/></svg>',
    );
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => /raster/i.test(v)));
  });

  it('fails an SVG containing <text> (outlined paths only)', () => {
    const result = checkTrueVector('<svg viewBox="0 0 10 10"><text x="0" y="0">Hi</text></svg>');
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => /text/.test(v)));
  });

  it('fails <foreignObject> and <script>', () => {
    for (const body of ['<foreignObject><div/></foreignObject>', '<script>alert(1)</script>']) {
      const result = checkTrueVector(`<svg viewBox="0 0 10 10">${body}</svg>`);
      assert.equal(result.pass, false, body);
    }
  });

  it('fails an event-handler attribute', () => {
    const result = checkTrueVector(
      '<svg viewBox="0 0 10 10"><path d="M0 0" onload="steal()"/></svg>',
    );
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => /event/i.test(v)));
  });

  it('fails an SVG with no viewBox', () => {
    const result = checkTrueVector('<svg><path d="M0 0"/></svg>');
    assert.equal(result.pass, false);
    assert.ok(result.violations.some((v) => /viewBox/.test(v)));
  });
});

describe('sanitizeSvg', () => {
  it('strips script elements and their contents', () => {
    const out = sanitizeSvg(
      '<svg viewBox="0 0 1 1"><script>alert(1)</script><path d="M0 0"/></svg>',
    );
    assert.ok(!/script/i.test(out));
    assert.ok(/<path/.test(out));
  });

  it('strips foreignObject blocks', () => {
    const out = sanitizeSvg(
      '<svg viewBox="0 0 1 1"><foreignObject><div>x</div></foreignObject><path d="M0 0"/></svg>',
    );
    assert.ok(!/foreignObject/i.test(out));
    assert.ok(/<path/.test(out));
  });

  it('strips on* event attributes but keeps legitimate ones', () => {
    const out = sanitizeSvg(
      '<svg viewBox="0 0 1 1"><path d="M0 0" onclick="x()" fill="#fff"/></svg>',
    );
    assert.ok(!/onclick/i.test(out));
    assert.ok(/fill="#fff"/.test(out));
    assert.ok(/d="M0 0"/.test(out));
  });

  it('produces output that passes the gate it defends', () => {
    const dirty =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
      '<script>x()</script><path d="M10 10 H90 V90 H10 Z" onmouseover="y()" fill="#000"/></svg>';
    assert.equal(checkTrueVector(sanitizeSvg(dirty)).pass, true);
  });
});

describe('namespace-prefix bypass regression tests (critical)', () => {
  it('CRITICAL: raw gate detects namespace-prefixed <ns1:script>', () => {
    const probe =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:ns1="http://www.w3.org/2000/svg" ' +
      'viewBox="0 0 10 10"><ns1:script>alert(document.domain)</ns1:script><path d="M0 0 L1 1" ' +
      'fill="#000"/></svg>';
    // Raw gate must detect and reject the ns1:script
    const rawResult = checkTrueVector(probe);
    assert.equal(rawResult.pass, false, 'raw gate should reject ns1:script');
    assert.ok(rawResult.violations.some((v) => /script/i.test(v)));
    // Sanitize+gate: sanitize strips the ns1:script, so gate passes on cleaned output
    const sanitized = sanitizeSvg(probe);
    const gatedResult = checkTrueVector(sanitized);
    assert.equal(
      gatedResult.pass,
      true,
      'after sanitize, ns1:script is removed so gate should pass',
    );
  });

  it('CRITICAL: raw gate detects namespace-prefixed <ns1:foreignObject>', () => {
    const probe =
      '<svg viewBox="0 0 10 10">' +
      '<ns1:foreignObject xmlns:ns1="http://www.w3.org/2000/svg">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" onclick="evil()">x</div>' +
      '</ns1:foreignObject><path d="M0 0 L1 1" fill="#000"/></svg>';
    // Raw gate must reject on both foreignObject and onclick
    const rawResult = checkTrueVector(probe);
    assert.equal(rawResult.pass, false, 'raw gate should reject ns1:foreignObject');
    assert.ok(
      rawResult.violations.some((v) => /foreignObject/i.test(v)),
      'should detect foreignObject in violations',
    );
    // Sanitize removes the ns1:foreignObject entirely (it's a dangerous element), so gate passes
    const sanitized = sanitizeSvg(probe);
    const gatedResult = checkTrueVector(sanitized);
    assert.equal(gatedResult.pass, true, 'sanitize removes foreignObject, leaving clean output');
  });

  it('CRITICAL: rejects namespace-prefixed <ns1:image> raster bypass', () => {
    const probe =
      '<svg viewBox="0 0 10 10">' +
      '<ns1:image xmlns:ns1="http://www.w3.org/2000/svg" href="https://evil.example.com/raster.png"/>' +
      '<path d="M0 0 L1 1" fill="#000"/></svg>';
    const result = checkTrueVector(probe);
    assert.equal(result.pass, false, 'ns1:image should fail even with a legitimate path sibling');
  });

  it('rejects javascript: href in <a> element', () => {
    const probe =
      '<svg viewBox="0 0 10 10">' +
      '<a href="javascript:alert(document.cookie)"><circle cx="5" cy="5" r="2"/></a></svg>';
    const result = checkTrueVector(probe);
    assert.equal(result.pass, false, 'javascript: href should fail');
    assert.ok(result.violations.some((v) => /javascript:/i.test(v)));
  });

  it('rejects lowercase "viewbox=" (case-sensitive per XML)', () => {
    const probe = '<svg viewbox="0 0 10 10"><path d="M0 0 L1 1" fill="#000"/></svg>';
    const result = checkTrueVector(probe);
    assert.equal(result.pass, false, 'lowercase viewbox should not satisfy the gate');
    assert.ok(result.violations.some((v) => /viewBox/.test(v)));
  });

  it('positive guard: realistic vendor SVG with defs/gradients/clipPath must PASS', () => {
    // A realistic SVG using all allowlisted elements should pass
    const vendor =
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
      '<linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="0%">' +
      '<stop offset="0%" style="stop-color:rgb(255,255,0);stop-opacity:1" />' +
      '<stop offset="100%" style="stop-color:rgb(255,0,0);stop-opacity:1" />' +
      '</linearGradient>' +
      '<clipPath id="clip"><rect x="10" y="10" width="80" height="80"/></clipPath>' +
      '</defs>' +
      '<title>My Logo</title>' +
      '<g clip-path="url(#clip)">' +
      '<path d="M 10 10 L 90 90" stroke="url(#grad1)" stroke-width="2"/>' +
      '<path d="M 90 10 L 10 90" stroke="url(#grad1)" stroke-width="2"/>' +
      '</g>' +
      '</svg>';
    const result = checkTrueVector(vendor);
    assert.equal(
      result.pass,
      true,
      `vendor SVG should pass; got violations: ${result.violations.join(', ')}`,
    );
  });

  it('CRITICAL: rejects namespace-prefixed <ns2:style>', () => {
    const probe =
      '<svg viewBox="0 0 10 10"><ns2:style xmlns:ns2="http://www.w3.org/2000/svg">*{fill:red}</ns2:style><path d="M0 0 L1 1"/></svg>';
    // Raw gate must reject ns2:style
    const rawResult = checkTrueVector(probe);
    assert.equal(rawResult.pass, false, 'raw gate should reject ns2:style');
    assert.ok(
      rawResult.violations.some((v) => /style/i.test(v)),
      'violation should name style element',
    );
    // After sanitize, ns2:style is still there (not a dangerous element in the stripped list)
    // but allowlist rejects it
    const sanitized = sanitizeSvg(probe);
    const gatedResult = checkTrueVector(sanitized);
    assert.equal(gatedResult.pass, false, 'ns2:style should fail the gate (not in allowlist)');
    assert.ok(gatedResult.violations.some((v) => /style/i.test(v)));
  });

  it('CRITICAL: rejects namespace-prefixed <ns9:iframe>', () => {
    const probe =
      '<svg viewBox="0 0 10 10"><ns9:iframe xmlns:ns9="http://www.w3.org/2000/svg" src="https://evil.example.com/x"/><path d="M0 0 L1 1"/></svg>';
    // Raw gate must reject ns9:iframe
    const rawResult = checkTrueVector(probe);
    assert.equal(rawResult.pass, false, 'raw gate should reject ns9:iframe');
    assert.ok(
      rawResult.violations.some((v) => /iframe/i.test(v)),
      'violation should name iframe element',
    );
    // After sanitize, ns9:iframe remains but should still fail
    const sanitized = sanitizeSvg(probe);
    const gatedResult = checkTrueVector(sanitized);
    assert.equal(gatedResult.pass, false, 'ns9:iframe should fail the gate (not in allowlist)');
    assert.ok(gatedResult.violations.some((v) => /iframe/i.test(v)));
  });

  it('CRITICAL: rejects namespace-prefixed <weird:animateTransform>', () => {
    const probe =
      '<svg viewBox="0 0 10 10"><weird:animateTransform xmlns:weird="http://www.w3.org/2000/svg" xlink:href="#x"/><path d="M0 0 L1 1"/></svg>';
    // Raw gate must reject weird:animateTransform
    const rawResult = checkTrueVector(probe);
    assert.equal(rawResult.pass, false, 'raw gate should reject weird:animateTransform');
    assert.ok(
      rawResult.violations.some((v) => /animateTransform/i.test(v)),
      'violation should name animateTransform',
    );
    // After sanitize, weird:animateTransform remains but should still fail
    const sanitized = sanitizeSvg(probe);
    const gatedResult = checkTrueVector(sanitized);
    assert.equal(gatedResult.pass, false, 'weird:animateTransform should fail (not in allowlist)');
    assert.ok(gatedResult.violations.some((v) => /animateTransform/i.test(v)));
  });

  it('positive guard: vendor SVG with metadata+RDF must PASS after sanitize (metadata stripped)', () => {
    // Vendor metadata with RDF: raw gate may reject due to rdf:RDF and dc:title,
    // but sanitize removes the metadata subtree, leaving clean output.
    // Test only the sanitize→gate sequence.
    const vendorWithMetadata =
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
      '<metadata>' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description>' +
      '<dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">My Logo</dc:title>' +
      '</rdf:Description>' +
      '</rdf:RDF>' +
      '</metadata>' +
      '<defs><linearGradient id="g1"><stop offset="0%"/></linearGradient></defs>' +
      '<path d="M 10 10 L 90 90" stroke="url(#g1)" stroke-width="2"/>' +
      '</svg>';
    // After sanitize: metadata subtree is stripped, leaving only defs + path + viewBox
    const sanitized = sanitizeSvg(vendorWithMetadata);
    const result = checkTrueVector(sanitized);
    assert.equal(
      result.pass,
      true,
      `vendor SVG with metadata should pass after sanitize; got violations: ${result.violations.join(', ')}`,
    );
  });
});
