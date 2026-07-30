// ---------------------------------------------------------------------------
// Font set for Satori (PRD §5 FR-1, §7).
//
// Fonts are the OFL-licensed Inter static TTFs vendored next to this file
// (Inter-Regular.ttf / Inter-Bold.ttf, license in OFL.txt). No runtime font
// egress on the render path — the FR-1 / Non-Goal hard rule.
//
// Two load paths, one shared `createFontSet`:
//   - Worker: import the .ttf files as bundled bytes (wrangler's default rule
//     turns a `.ttf` import into an ArrayBuffer) and pass them to
//     `createFontSet`. This module stays Node-global-free so it is safe to
//     import from Worker code.
//   - Node (tests / local): `./node.ts`'s `loadFontsNode()` reads the two TTFs
//     off disk with `node:fs` and calls `createFontSet`. Never import `./node`
//     from Worker code.
// ---------------------------------------------------------------------------

export const FONT_FAMILY = 'Inter';

export type FontWeight = 400 | 700;

/** One Satori font face. `data` is the raw TTF as an ArrayBuffer. */
export interface FontSpec {
  name: string;
  data: ArrayBuffer;
  weight: FontWeight;
  style: 'normal' | 'italic';
}

export type FontSet = FontSpec[];

/** Copy any byte source into a standalone ArrayBuffer (Buffer views share a pool). */
export function toArrayBuffer(bytes: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  const view = bytes as ArrayBufferView;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

/**
 * Build the Inter Regular (400) + Bold (700) font set from raw TTF bytes.
 * Shared by both the Worker bundle-import path and the Node fs path.
 */
export function createFontSet(
  regular: ArrayBuffer | ArrayBufferView,
  bold: ArrayBuffer | ArrayBufferView,
): FontSet {
  return [
    { name: FONT_FAMILY, data: toArrayBuffer(regular), weight: 400, style: 'normal' },
    { name: FONT_FAMILY, data: toArrayBuffer(bold), weight: 700, style: 'normal' },
  ];
}
