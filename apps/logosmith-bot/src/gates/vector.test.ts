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
