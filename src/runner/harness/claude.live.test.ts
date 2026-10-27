import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeHarness } from './claude.js';

// Opt-in: `DROMOS_LIVE=claude pnpm test` calls the real SDK (needs a logged-in `claude`; costs tokens).
describe.runIf(process.env.DROMOS_LIVE?.split(',').includes('claude'))('ClaudeHarness live', () => {
  it('answers with JSON matching the schema', { timeout: 120_000 }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dromos-live-'));
    try {
      const harness = new ClaudeHarness();
      const out = await harness.runPhase({
        prompt: 'Do not use any tool. Reply with the JSON {"answer": 4} for 2 + 2.',
        cwd,
        model: 'haiku',
        skills: [],
        allow: () => ({ allow: false, reason: 'no tools in the live test' }),
        schema: z.strictObject({ answer: z.literal(4) }),
        timeoutMs: 110_000,
      });
      expect(out.result).toEqual({ answer: 4 });
      expect(out.usage?.outputTokens).toBeGreaterThan(0);
      expect((await harness.header()).sdk).not.toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
