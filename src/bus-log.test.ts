import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusLog, formatLogLine } from './bus-log.js';

describe('formatLogLine', () => {
  it('formats time, padded kind and text', () => {
    const at = new Date(2026, 8, 24, 5, 7, 9);
    expect(formatLogLine('HOOK', 'implementer idle (claude)', at)).toBe(
      '05:07:09 HOOK         implementer idle (claude)',
    );
  });

  it('pads the longest kind to 12 columns with one separating space', () => {
    expect(formatLogLine('MESSAGE', 'x', new Date(2026, 0, 1, 0, 0, 0))).toBe(
      '00:00:00 MESSAGE      x',
    );
  });

  it('keeps every entry on a single line', () => {
    expect(formatLogLine('ERROR', 'a\nb\r\nc', new Date(2026, 0, 1))).toMatch(/ a b c$/);
  });
});

describe('createBusLog', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-bus-log-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends lines to <dataDir>/bus.log, creating the directory', () => {
    const log = createBusLog(join(dir, 'nested'));
    log.logLine('STATE', 'run-1 implementing');
    log.logLine('GATE', 'run-1 passed');
    const lines = readFileSync(log.file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2} STATE {8}run-1 implementing$/);
  });

  it('does not throw when the file cannot be written', () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file, not a directory');
    const log = createBusLog(join(blocker, 'data'));
    expect(() => log.logLine('ERROR', 'x')).not.toThrow();
  });
});
