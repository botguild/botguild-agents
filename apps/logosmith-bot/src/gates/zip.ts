// ZIP completeness gate (FR-13, §9). The pack is unzipped and checked entry by
// entry: every required file present and non-empty, the webmanifest parses as
// JSON, and every href in the HTML snippet resolves to a real entry. A pack
// whose snippet points at a file we never wrote is a broken deliverable even
// though every individual render passed.

import { REQUIRED_ZIP_ENTRIES, unzipFiles } from '../pack/zip.js';

export interface ZipGateResult {
  pass: boolean;
  present: string[];
  missing: string[];
  reasons: string[];
}

export function checkZipCompleteness(
  zip: Uint8Array,
  required: readonly string[] = REQUIRED_ZIP_ENTRIES,
): ZipGateResult {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipFiles(zip);
  } catch {
    return { pass: false, present: [], missing: [...required], reasons: ['buffer did not unzip'] };
  }

  const present = Object.keys(files);
  const missing = required.filter((name) => !(name in files));
  const reasons: string[] = [];
  if (missing.length > 0) reasons.push(`missing entries: ${missing.join(', ')}`);

  for (const name of required) {
    const bytes = files[name];
    if (bytes && bytes.byteLength === 0) reasons.push(`${name} is present but empty`);
  }

  const manifest = files['site.webmanifest'];
  if (manifest) {
    try {
      JSON.parse(new TextDecoder().decode(manifest));
    } catch {
      reasons.push('site.webmanifest did not parse as JSON');
    }
  }

  const snippet = files['snippet.html'];
  if (snippet) {
    const html = new TextDecoder().decode(snippet);
    for (const match of html.matchAll(/href="([^"]+)"/g)) {
      const ref = match[1]!;
      if (!(ref in files)) reasons.push(`snippet.html references a missing entry: ${ref}`);
    }
  }

  return { pass: reasons.length === 0, present, missing, reasons };
}
