// FR-9 eject-ZIP gates: build the eject archive and unzip-and-assert it before delivery.
// `buildEjectZip` writes entries in sorted-path order (with a fixed `mtime`) so identical
// entries always produce byte-identical output regardless of caller insertion order —
// deliverable hashes stay reproducible. `verifyEjectZip` is the FR-9 gate itself: it must
// never throw (a corrupt archive is a reported failure, not an exception) and it collects
// every problem it finds rather than stopping at the first.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export interface VerifyEjectZipResult {
  ok: boolean;
  errors: string[];
}

// Fixed mtime for every entry (fflate defaults to "now" otherwise, which would make the
// archive bytes depend on wall-clock time). Must fall inside the DOS date range the ZIP
// format encodes (1980–2099) — epoch 0 is out of range, so this picks an arbitrary fixed
// date instead.
const DETERMINISTIC_MTIME = new Date('2020-01-01T00:00:00Z');

/** Deterministic build: fixed mtime + sorted path order, so the same entry set always
 *  zips to identical bytes no matter the insertion order the caller happened to build the
 *  record in. */
export function buildEjectZip(entries: Record<string, Uint8Array | string>): Uint8Array {
  const zippable: Record<string, Uint8Array> = {};
  for (const path of Object.keys(entries).sort()) {
    const value = entries[path];
    zippable[path] = typeof value === 'string' ? strToU8(value) : value;
  }
  return zipSync(zippable, { mtime: DETERMINISTIC_MTIME });
}

/** Strips `//`-style line comments (jsonc) so wrangler.jsonc etc. can go through
 *  `JSON.parse`. Comment markers inside quoted strings are left alone. */
function stripJsonComments(text: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      i--; // let the for-loop's increment land back on the newline (or end of text)
      continue;
    }

    result += ch;
  }

  return result;
}

/** Unzips and asserts the FR-9 eject-ZIP invariants: every `requiredPath` present and
 *  non-empty (README.md included, when the caller lists it as required — no special-casing
 *  needed, it follows the same rule as everything else), and every `.json`/`.jsonc` member
 *  in the archive parses (after stripping `//` comments). Never throws — a corrupt zip is
 *  `{ ok: false, errors: [...] }`, not an exception. */
export function verifyEjectZip(zip: Uint8Array, requiredPaths: string[]): VerifyEjectZipResult {
  const errors: string[] = [];
  let unzipped: Record<string, Uint8Array>;

  try {
    unzipped = unzipSync(zip);
  } catch (err) {
    return {
      ok: false,
      errors: [`corrupt zip: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  for (const path of requiredPaths) {
    const bytes = unzipped[path];
    if (bytes === undefined) {
      errors.push(`missing required path: ${path}`);
    } else if (bytes.length === 0) {
      errors.push(`required path is empty: ${path}`);
    }
  }

  for (const [path, bytes] of Object.entries(unzipped)) {
    if (path.endsWith('/')) continue; // directory marker entries
    if (!path.endsWith('.json') && !path.endsWith('.jsonc')) continue;
    try {
      JSON.parse(stripJsonComments(strFromU8(bytes)));
    } catch (err) {
      errors.push(`invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
