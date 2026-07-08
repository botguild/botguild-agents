// ---------------------------------------------------------------------------
// File-size + quality-floor gate (PRD §9, FR-8).
//
// A pure DECISION over an already-encoded buffer — it never re-encodes and
// never loops. PNG is lossless and preferred: it passes when under the ceiling,
// and when it is over, the only remedy is a re-compose (palette/complexity
// reduction) signal — PNG has no quality knob. JPEG passes only when it is both
// under the ceiling AND at or above the declared quality floor; a floor-quality
// JPEG that is still over the ceiling emits a re-compose signal rather than
// degrading below the floor.
// ---------------------------------------------------------------------------

import {
  DEFAULT_JPEG_QUALITY_FLOOR,
  MAX_FILE_BYTES,
  type EncodeResult,
} from '../render/encodeTypes.js';

export interface FileSizeOptions {
  maxBytes?: number;
  jpegQualityFloor?: number;
}

export type FileSizeReason =
  | 'ok'
  /** PNG over the ceiling — re-compose at lower visual complexity / palette. */
  | 'png-over-ceiling-recompose'
  /** JPEG at the floor still over the ceiling — re-compose, never degrade further. */
  | 'jpeg-floor-over-ceiling-recompose'
  /** JPEG below the declared quality floor — must never ship. */
  | 'jpeg-below-quality-floor';

export interface FileSizeDecision {
  pass: boolean;
  reason: FileSizeReason;
  /** True when the caller should re-compose rather than deliver. */
  recompose: boolean;
  format: EncodeResult['format'];
  byteLength: number;
  quality?: number;
  maxBytes: number;
  jpegQualityFloor: number;
}

/** Decide whether an encoded buffer clears the size ceiling + quality floor. */
export function checkFileSize(
  encoded: EncodeResult,
  options: FileSizeOptions = {},
): FileSizeDecision {
  const maxBytes = options.maxBytes ?? MAX_FILE_BYTES;
  const jpegQualityFloor = options.jpegQualityFloor ?? DEFAULT_JPEG_QUALITY_FLOOR;
  const base = {
    format: encoded.format,
    byteLength: encoded.byteLength,
    quality: encoded.quality,
    maxBytes,
    jpegQualityFloor,
  };
  const underCeiling = encoded.byteLength <= maxBytes;

  if (encoded.format === 'png') {
    return underCeiling
      ? { pass: true, reason: 'ok', recompose: false, ...base }
      : { pass: false, reason: 'png-over-ceiling-recompose', recompose: true, ...base };
  }

  // JPEG path.
  if ((encoded.quality ?? 0) < jpegQualityFloor) {
    return { pass: false, reason: 'jpeg-below-quality-floor', recompose: true, ...base };
  }
  return underCeiling
    ? { pass: true, reason: 'ok', recompose: false, ...base }
    : { pass: false, reason: 'jpeg-floor-over-ceiling-recompose', recompose: true, ...base };
}
