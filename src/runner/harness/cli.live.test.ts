import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CliHarness } from './cli.js';

// Opt-in: `DROMOS_LIVE=copilot pnpm test` calls the real `copilot` (needs a logged-in CLI; costs credits).
describe.runIf(process.env.DROMOS_LIVE?.split(',').includes('copilot'))(
  'CliHarness copilot live',
  () => {
    it('answers and reports usage', { timeout: 120_000 }, async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'dromos-live-'));
      try {
        const harness = new CliHarness({ name: 'copilot' });
        const out = await harness.runPhase({
          prompt: 'Do not use any tool. Reply with the single word: ok',
          cwd,
          model: 'auto',
          skills: [],
          allow: () => ({ allow: false, reason: 'no tools in the live test' }),
          schema: z.string().min(1),
          timeoutMs: 110_000,
        });
        expect(String(out.result).toLowerCase()).toContain('ok');
        expect(out.usage?.outputTokens).toBeGreaterThan(0);
        expect(await harness.version()).toMatch(/\d+\.\d+\.\d+/);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  },
);
