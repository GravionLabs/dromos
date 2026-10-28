import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dromosVersion } from './version.js';

describe('dromosVersion', () => {
  it('reads the version of package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(dromosVersion()).toBe(pkg.version);
  });
});
