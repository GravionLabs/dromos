import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json')) as Record<string, unknown>;
const workflow = read('.github/workflows/release.yml');
const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));

describe('package.json publish config', () => {
  it('is public and not private', () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig).toEqual({ access: 'public' });
  });

  it('ships only what the installed CLI needs', () => {
    expect(pkg.files).toEqual(['dist/', 'schema/', 'README.md', 'LICENSE', 'CHANGELOG.md']);
  });
});

describe('release.yml publish job', () => {
  it('exists and needs the release job', () => {
    expect(publishJob).toMatch(/^\n {2}publish:/);
    expect(publishJob).toMatch(/needs:\s*\[[^\]]*\brelease\b[^\]]*\]/);
  });

  it('authenticates with OIDC and no NPM_TOKEN', () => {
    expect(publishJob).toContain('id-token: write');
    expect(workflow).not.toContain('NPM_TOKEN');
  });

  it('checks out the tag, sets the version without committing and publishes with provenance', () => {
    expect(publishJob).toMatch(/ref: v\$\{\{ needs\.determine-version\.outputs\.semver \}\}/);
    expect(publishJob).toContain('--no-git-tag-version');
    expect(publishJob).toContain('npm publish --provenance --access public');
  });

  it('skips a version that already exists on npm', () => {
    expect(publishJob).toContain('npm view');
    expect(publishJob).toContain('::notice::');
  });
});
