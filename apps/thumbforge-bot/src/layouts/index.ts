// Layout registry (PRD §8 output artifacts). Every deliverable format maps to a
// typed, serializable LayoutDescriptor here.

import type { LayoutDescriptor } from './types.js';
import { og } from './og.js';
import { thumbnailA } from './thumbnailA.js';
import { thumbnailB } from './thumbnailB.js';
import { socialFeed } from './socialFeed.js';
import { socialStory } from './socialStory.js';

export { og, thumbnailA, thumbnailB, socialFeed, socialStory };
export * from './types.js';

/** All layouts keyed by templateId. */
export const LAYOUTS: Record<string, LayoutDescriptor> = {
  [og.templateId]: og,
  [thumbnailA.templateId]: thumbnailA,
  [thumbnailB.templateId]: thumbnailB,
  [socialFeed.templateId]: socialFeed,
  [socialStory.templateId]: socialStory,
};

/** The two layout-distinct variants for a YouTube A/B thumbnail gig (§9). */
export const THUMBNAIL_VARIANTS: [LayoutDescriptor, LayoutDescriptor] = [thumbnailA, thumbnailB];
