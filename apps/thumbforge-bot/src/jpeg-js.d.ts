// Minimal typings for `jpeg-js` (no bundled types, no @types package). Used as
// the pure-TypeScript JPEG encoder fallback for the mozjpeg wasm path (§7).
declare module 'jpeg-js' {
  export interface RawImageData {
    data: Uint8Array | Uint8ClampedArray;
    width: number;
    height: number;
  }
  export interface EncodedImage {
    data: Uint8Array;
    width: number;
    height: number;
  }
  export function encode(imageData: RawImageData, quality?: number): EncodedImage;
  export function decode(data: Uint8Array | ArrayBuffer, options?: unknown): RawImageData;
  const jpeg: { encode: typeof encode; decode: typeof decode };
  export default jpeg;
}
