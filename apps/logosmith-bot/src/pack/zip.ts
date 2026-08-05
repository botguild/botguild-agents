// Pack ZIP assembly (FR-11) and the §8 entry contract. The entry list is the
// single source of truth shared by the builder, the snippet, and the
// completeness gate — so "the gate checks what we actually ship" is structural
// rather than something two lists have to agree about by hand.

import { unzipSync, zipSync } from 'fflate';

/** Every file the §8 M2 deliverable must contain. */
export const REQUIRED_ZIP_ENTRIES: readonly string[] = [
  'logo.svg',
  'logo-mono.svg',
  'logo-color-1024.png',
  'logo-color-2048.png',
  'logo-mono-1024.png',
  'favicon.ico',
  'favicon-16.png',
  'favicon-32.png',
  'favicon-48.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'site.webmanifest',
  'snippet.html',
  'brand.json',
];

/**
 * The FREE favicon gig's smaller contract (US-2 AC2) — favicons, manifest, and
 * snippet only. Deliberately NO logo.svg, mono mark, colour masters, or
 * brand.json: the source is the buyer's existing logo, usually a raster, so
 * there is no true-vector deliverable to promise.
 */
export const FAVICON_ZIP_ENTRIES: readonly string[] = [
  'favicon.ico',
  'favicon-16.png',
  'favicon-32.png',
  'favicon-48.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'site.webmanifest',
  'snippet.html',
];

export function zipFiles(files: Record<string, Uint8Array>): Uint8Array {
  return zipSync(files, { level: 6 });
}

export function unzipFiles(zip: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(zip);
}

/** A valid web app manifest naming the brand and the two PWA icon sizes. */
export function buildWebmanifest(brandName: string): string {
  return JSON.stringify(
    {
      name: brandName,
      short_name: brandName,
      icons: [
        { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
      theme_color: '#ffffff',
      background_color: '#ffffff',
      display: 'standalone',
    },
    null,
    2,
  );
}

/** The drop-in <head> snippet. Every href must resolve to a ZIP entry. */
export function buildHtmlSnippet(): string {
  return [
    '<link rel="icon" href="favicon.ico" sizes="any">',
    '<link rel="icon" type="image/png" sizes="16x16" href="favicon-16.png">',
    '<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">',
    '<link rel="icon" type="image/png" sizes="48x48" href="favicon-48.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">',
    '<link rel="manifest" href="site.webmanifest">',
  ].join('\n');
}
