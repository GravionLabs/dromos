import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { colorize, lastLines, runLogCli } from './log.js';

const ESC = '\u001b';
const R = `${ESC}[0m`;

describe('colorize', () => {
  it('colors STATE bold yellow', () => {
    expect(colorize('10:00:00 STATE        x')).toBe(`${ESC}[1;33m10:00:00 STATE        x${R}`);
  });

  it('colors GATE green when passed, else red', () => {
    expect(colorize('10:00:00 GATE         build passed')).toContain(`${ESC}[32m`);
    expect(colorize('10:00:00 GATE         build failed')).toContain(`${ESC}[31m`);
  });

  it('colors REVIEW magenta, HOOK dim, ERROR bold red', () => {
    expect(colorize('10:00:00 REVIEW       x')).toContain(`${ESC}[35m`);
    expect(colorize('10:00:00 HOOK         x')).toContain(`${ESC}[2m`);
    expect(colorize('10:00:00 ERROR        x')).toContain(`${ESC}[1;31m`);
  });

  it('keeps the model in HOOK lines', () => {
    expect(colorize('10:00:00 HOOK         implementer idle (claude, opus)')).toContain(
      '(claude, opus)',
    );
  });

  it('colors role names and restores the line color', () => {
    expect(colorize('10:00:00 MESSAGE      orchestrator -> reviewer')).toBe(
      `10:00:00 MESSAGE      ${R}${ESC}[36morchestrator${R} -> ${R}${ESC}[35mreviewer${R}`,
    );
    expect(colorize('10:00:00 STATE        implementer ok')).toContain(
      `${R}${ESC}[34mimplementer${R}${ESC}[1;33m ok`,
    );
  });

  it('leaves unrecognised lines untouched', () => {
    expect(colorize('garbage')).toBe('garbage');
  });
});

describe('lastLines', () => {
  it('returns the last n lines', () => {
    expect(lastLines('a\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(lastLines('', 5)).toEqual([]);
    expect(lastLines('a\n', 0)).toEqual([]);
  });
});

describe('runLogCli', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const waitFor = async (cond: () => boolean): Promise<void> => {
    const end = Date.now() + 3000;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(cond()).toBe(true);
  };

  it('creates a missing file, follows appends and restarts after truncation', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dromos-log-'));
    const file = join(dir, 'sub', 'bus.log');
    const out: string[] = [];
    const ac = new AbortController();
    const done = runLogCli(
      { lines: '2', color: false },
      { file, env: {}, out: (l) => out.push(l), signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 50));
    appendFileSync(file, '10:00:00 STATE        one\n10:00:01 STATE        two\n');
    await waitFor(() => out.length === 2);
    expect(out).toEqual(['10:00:00 STATE        one', '10:00:01 STATE        two']);
    writeFileSync(file, '10:00:02 STATE        3\n');
    await waitFor(() => out.length === 3);
    expect(out[2]).toBe('10:00:02 STATE        3');
    ac.abort();
    expect(await done).toBe(0);
  });

  it('prints only the last N existing lines and honours NO_COLOR', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dromos-log-'));
    const file = join(dir, 'bus.log');
    writeFileSync(file, '10:00:00 ERROR        a\n10:00:01 ERROR        b\n');
    const out: string[] = [];
    const ac = new AbortController();
    ac.abort();
    await runLogCli(
      { lines: '1' },
      { file, env: { NO_COLOR: '1' }, out: (l) => out.push(l), signal: ac.signal },
    );
    expect(out).toEqual(['10:00:01 ERROR        b']);
  });

  it('colors by default and rejects a bad --lines', async () => {
    dir = mkdtempSync(join(tmpdir(), 'dromos-log-'));
    const file = join(dir, 'bus.log');
    writeFileSync(file, '10:00:00 ERROR        x\n');
    const out: string[] = [];
    const errs: string[] = [];
    const ac = new AbortController();
    ac.abort();
    await runLogCli({}, { file, env: {}, out: (l) => out.push(l), signal: ac.signal });
    expect(out[0]).toContain(`${ESC}[1;31m`);
    expect(await runLogCli({ lines: 'x' }, { file, err: (l) => errs.push(l) })).toBe(1);
    expect(errs[0]).toContain('--lines');
  });
});
