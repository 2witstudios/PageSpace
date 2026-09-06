/**
 * Every Dockerfile that installs the monorepo copies each workspace's
 * package.json BEFORE `bun install --frozen-lockfile`, because the lockfile
 * names every workspace and the install fails if one manifest is missing.
 * That failure surfaces ONLY at image-build time — never in local dev, never
 * in CI's typecheck/test jobs — so a new workspace package silently breaks
 * every deploy unless every manifest block gains a COPY line for it.
 *
 * This walks the same eight Dockerfiles and asserts that wherever
 * `packages/lib/package.json` is copied, `packages/editor/package.json` is
 * copied in the same block, with the same COPY source form (plain, or
 * `--from=builder` in apps/realtime's runner stage).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');

const DOCKERFILES = [
  'apps/admin/Dockerfile',
  'apps/marketing/Dockerfile',
  'apps/processor/Dockerfile',
  'apps/realtime/Dockerfile',
  'apps/web/Dockerfile',
  'apps/web/Dockerfile.migrate',
  'apps/web/Dockerfile.seed',
  'apps/web/Dockerfile.worker',
];

const WORKSPACE_PACKAGES = ['db', 'lib', 'editor', 'sdk', 'cli'];

function manifestCopyLines(dockerfile: string, pkg: string): string[] {
  const re = new RegExp(`^COPY (?:--from=\\S+ )?\\S*packages/${pkg}/package\\.json \\./packages/${pkg}/$`, 'gm');
  return dockerfile.match(re) ?? [];
}

describe('Dockerfile workspace manifest COPY blocks', () => {
  for (const file of DOCKERFILES) {
    it(`given ${file}, should copy packages/editor/package.json beside every packages/lib/package.json`, () => {
      const dockerfile = readFileSync(join(ROOT, file), 'utf-8');
      const libSites = manifestCopyLines(dockerfile, 'lib');
      expect(libSites.length, `${file} has no lib manifest COPY — test assumptions broken`).toBeGreaterThan(0);
      const editorSites = manifestCopyLines(dockerfile, 'editor');
      // Same count AND same source form (a `--from=builder` lib line needs a
      // `--from=builder` editor line, or the runner stage's install fails).
      expect(editorSites.map((l) => l.replaceAll('editor', 'lib'))).toEqual(libSites);
    });

    it(`given ${file}, should copy every workspace package manifest an equal number of times`, () => {
      const dockerfile = readFileSync(join(ROOT, file), 'utf-8');
      const counts = WORKSPACE_PACKAGES.map((pkg) => manifestCopyLines(dockerfile, pkg).length);
      expect(new Set(counts).size, `uneven manifest COPY counts ${JSON.stringify(Object.fromEntries(WORKSPACE_PACKAGES.map((p, i) => [p, counts[i]])))}`).toBe(1);
    });
  }

  it('given apps/realtime/Dockerfile, should have two manifest blocks (builder and runner)', () => {
    const dockerfile = readFileSync(join(ROOT, 'apps/realtime/Dockerfile'), 'utf-8');
    expect(manifestCopyLines(dockerfile, 'editor')).toHaveLength(2);
  });
});
