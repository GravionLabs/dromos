import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Harness, type PhaseInput, RunEventSchema } from './harness.js';

/** A fake harness: returns a canned result, validated against the phase schema like a real one. */
const fakeHarness: Harness = {
  async runPhase(input) {
    return {
      result: input.schema.parse({ status: 'done' }),
      events: [{ at: '2026-10-27T10:00:00.000Z', kind: 'tool', summary: 'Read README.md' }],
      usage: null,
    };
  },
};

const input: PhaseInput = {
  prompt: 'implement #1',
  cwd: '/tmp/wt',
  model: 'sonnet',
  skills: ['implementation'],
  allow: () => ({ allow: true }),
  schema: z.object({ status: z.literal('done') }),
  timeoutMs: 1000,
};

describe('Harness', () => {
  it('returns result, events and usage', async () => {
    const out = await fakeHarness.runPhase(input);
    expect(out.result).toEqual({ status: 'done' });
    expect(out.events).toHaveLength(1);
    expect(out.usage).toBeNull();
  });

  it('lets the phase schema reject a result that does not match', async () => {
    await expect(
      fakeHarness.runPhase({ ...input, schema: z.object({ status: z.literal('failed') }) }),
    ).rejects.toThrow();
  });
});

describe('RunEventSchema', () => {
  const ok = { at: '2026-10-27T10:00:00.000Z', kind: 'message', summary: 'hi' };

  it('accepts an event', () => {
    expect(RunEventSchema.safeParse(ok).success).toBe(true);
  });

  it.each([
    ['unknown kind', { ...ok, kind: 'other' }],
    ['empty summary', { ...ok, summary: '' }],
    ['unknown key', { ...ok, extra: 1 }],
    ['bad timestamp', { ...ok, at: 'now' }],
  ])('rejects %s', (_n, event) => {
    expect(RunEventSchema.safeParse(event).success).toBe(false);
  });
});
