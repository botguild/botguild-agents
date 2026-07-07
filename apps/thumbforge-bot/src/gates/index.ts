// The §9 gate suite — pure functions over the rendered pixmap + layout metadata
// (no Workers globals, no live APIs). The wiring phase composes these into the
// pre-delivery gate run.

export * from './dimensions.js';
export * from './filesize.js';
export * from './color.js';
export * from './logo.js';
export * from './phash.js';
export * from './template.js';
export * from './reconcile.js';
