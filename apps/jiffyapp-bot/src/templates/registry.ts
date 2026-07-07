// Catalog registry: maps TemplateId -> TemplateDefinition. Grows one template at a
// time (Tasks 5-8); Task 8 completes the catalog and switches TEMPLATES to a total
// Record<TemplateId, TemplateDefinition>.

import type { FileSet, TemplateId } from '../types.js';
import { CALCULATOR } from './calculator.js';
import type { RenderContext, TemplateDefinition } from './engine.js';
import { LANDING } from './landing.js';

export const TEMPLATES: Partial<Record<TemplateId, TemplateDefinition>> = {
  landing: LANDING,
  calculator: CALCULATOR,
};

export function getTemplate(id: TemplateId): TemplateDefinition {
  const def = TEMPLATES[id];
  if (!def) throw new Error(`unknown template: ${id}`);
  return def;
}

export const REFERENCE_CTX: RenderContext = {
  slug: 'reference',
  toolUrl: 'https://reference.jiffyapp.dev',
  publicBaseUrl: 'https://jiffyapp-bot.example.workers.dev',
  relay: null,
};

/** Render a template's referenceSlots with a fixed ctx — shared by every template test. */
export function renderReference(def: TemplateDefinition): { files: FileSet; html: string } {
  const ctx: RenderContext =
    def.id === 'form' || def.id === 'waitlist' || def.id === 'quiz'
      ? { ...REFERENCE_CTX, relay: { toolId: 'ref-tool', token: 'ref-token' } }
      : REFERENCE_CTX;
  const files = def.render(def.referenceSlots, ctx);
  return { files, html: files['/index.html'].content };
}
