// Encoding value types + the §9 byte ceilings. Kept free of satori/resvg/wasm
// imports so the pure gates (filesize) can depend on them without pulling the
// render engine.

/** The 2MB hard ceiling (PRD §9). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Default JPEG quality floor — encoding never drops below this (PRD §9, FR-8). */
export const DEFAULT_JPEG_QUALITY_FLOOR = 70;

export interface EncodeResult {
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
  /** Present only on the JPEG path. */
  quality?: number;
  byteLength: number;
}

export interface EncodeOptions {
  maxBytes?: number;
  jpegQualityFloor?: number;
}
