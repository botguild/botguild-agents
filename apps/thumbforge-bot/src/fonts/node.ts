// ---------------------------------------------------------------------------
// Node-only font loader (tests + local dev). Reads the vendored Inter TTFs off
// disk with `node:fs`. NEVER import this from Worker code — the Worker bundles
// the fonts as byte imports and calls `createFontSet` directly (see ./index.ts).
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { createFontSet, type FontSet } from './index.js';

/** Load the Inter Regular + Bold TTFs from disk into a Satori font set. */
export async function loadFontsNode(): Promise<FontSet> {
  const [regular, bold] = await Promise.all([
    readFile(new URL('./Inter-Regular.ttf', import.meta.url)),
    readFile(new URL('./Inter-Bold.ttf', import.meta.url)),
  ]);
  return createFontSet(regular, bold);
}
