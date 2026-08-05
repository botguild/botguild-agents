import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AXES, buildAxisPrompt, createAxisCompiler } from './axes.js';
import type { LogoBrief } from './types.js';

const brief: LogoBrief = {
  brandName: 'Harbor & Vine',
  industry: 'boutique inn',
  brief: 'coastal, warm, understated luxury',
  avoid: ['anchors', 'rope'],
  palettePreference: ['#0F3D3E'],
};

describe('DEFAULT_AXES', () => {
  it('declares three distinct axes routed to the right vendors', () => {
    assert.equal(DEFAULT_AXES.length, 3);
    assert.equal(new Set(DEFAULT_AXES.map((a) => a.id)).size, 3);
    // Lettering-heavy axes go to Ideogram; the icon-led axis to Recraft (FR-4).
    assert.ok(DEFAULT_AXES.some((a) => a.vendor === 'recraft'));
    assert.ok(DEFAULT_AXES.filter((a) => a.vendor === 'ideogram').length >= 1);
  });
});

describe('buildAxisPrompt', () => {
  it('embeds the exact brand string (FR-3)', () => {
    const prompt = buildAxisPrompt(brief, DEFAULT_AXES[0]!);
    assert.ok(prompt.includes('Harbor & Vine'));
  });

  it('carries the industry, the free-text brief, and the avoid list', () => {
    const prompt = buildAxisPrompt(brief, DEFAULT_AXES[0]!);
    assert.ok(prompt.includes('boutique inn'));
    assert.ok(prompt.includes('understated luxury'));
    assert.ok(/anchors/.test(prompt));
  });

  it('works when every optional field is absent', () => {
    const prompt = buildAxisPrompt({ brandName: 'Acme', industry: 'tools' }, DEFAULT_AXES[1]!);
    assert.ok(prompt.includes('Acme'));
    assert.ok(prompt.length > 0);
  });
});

describe('createAxisCompiler', () => {
  const fakeAnthropic = (payload: unknown) => ({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    },
  });

  it('returns three axes with the brand string in every prompt', async () => {
    const compiler = createAxisCompiler({
      anthropic: fakeAnthropic({
        axes: DEFAULT_AXES.map((a) => ({
          id: a.id,
          label: a.label,
          prompt: `${a.label} for Harbor & Vine`,
        })),
      }) as never,
    });
    const axes = await compiler.compile(brief);
    assert.equal(axes.length, 3);
    for (const axis of axes) assert.ok(axis.prompt.includes('Harbor & Vine'));
  });

  it('falls back to the default axes when the model returns unusable JSON', async () => {
    const compiler = createAxisCompiler({
      anthropic: fakeAnthropic({ nope: true }) as never,
    });
    const axes = await compiler.compile(brief);
    assert.equal(axes.length, 3);
    assert.deepEqual(
      axes.map((a) => a.id),
      DEFAULT_AXES.map((a) => a.id),
    );
  });

  it('falls back when the model call throws', async () => {
    const compiler = createAxisCompiler({
      anthropic: {
        messages: {
          create: async () => {
            throw new Error('overloaded');
          },
        },
      } as never,
    });
    assert.equal((await compiler.compile(brief)).length, 3);
  });

  it('preserves the vendor routing regardless of what the model returns', async () => {
    const compiler = createAxisCompiler({
      anthropic: fakeAnthropic({
        axes: DEFAULT_AXES.map((a) => ({ id: a.id, label: 'x', prompt: 'y', vendor: 'flux' })),
      }) as never,
    });
    const axes = await compiler.compile(brief);
    assert.deepEqual(
      axes.map((a) => a.vendor),
      DEFAULT_AXES.map((a) => a.vendor),
    );
  });
});
