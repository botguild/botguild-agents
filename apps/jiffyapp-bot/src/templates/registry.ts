// Catalog registry: maps TemplateId -> TemplateDefinition. Grew one template at a
// time (Tasks 5-8); Task 8 completes the catalog — TEMPLATES is now a total
// Record<TemplateId, TemplateDefinition>.

import type { FileSet, TemplateId } from '../types.js';
import { CALCULATOR } from './calculator.js';
import { CSV_DASHBOARD } from './csvDashboard.js';
import type { RenderContext, TemplateDefinition } from './engine.js';
import { FORM } from './form.js';
import { LANDING } from './landing.js';
import { LINK_IN_BIO } from './linkInBio.js';
import { PRICING_TABLE } from './pricingTable.js';
import { QUIZ } from './quiz.js';
import { TRANSFORMER } from './transformer.js';
import { WAITLIST } from './waitlist.js';
import { WIDGET } from './widget.js';

export const TEMPLATES: Record<TemplateId, TemplateDefinition> = {
  landing: LANDING,
  calculator: CALCULATOR,
  form: FORM,
  'csv-dashboard': CSV_DASHBOARD,
  widget: WIDGET,
  'link-in-bio': LINK_IN_BIO,
  'pricing-table': PRICING_TABLE,
  quiz: QUIZ,
  waitlist: WAITLIST,
  transformer: TRANSFORMER,
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
