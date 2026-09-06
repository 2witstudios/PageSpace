/**
 * Every Dockerfile that installs the monorepo copies each workspace's
 * package.json BEFORE `bun install --frozen-lockfile`, because the lockfile
 * names every workspace and the install fails if one manifest is missing.
 * That failure surfaces ONLY at image-build time — never in local dev, never
 * in CI's typecheck/test jobs — so a new workspace package silently breaks
 * every deploy unless every manifest block gains a COPY line for it.
 *
 * Both inventories are derived, not hand-listed: the packages from
 * `packages/*` on disk, the Dockerfiles from `apps/* /Dockerfile*`. A new
 * package or a new Dockerfile is therefore covered the moment it exists.
 * `packages/lib` is the reference: wherever it is copied, every other package
 * must be copied in the same form (plain, or `--from=<stage>` in a runner
 * stage that re-installs), the same number of times.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');

const WORKSPACE_PACKAGES = readdirSync(join(ROOT, 'packages')).filter((dir) =>
  existsSync(join(ROOT, 'packages', dir, 'package.json')),
);

const DOCKERFILES = readdirSync(join(ROOT, 'apps')).flatMap((app) =>
  readdirSync(join(ROOT, 'apps', app))
    .filter((f) => f.startsWith('Dockerfile'))
    .map((f) => `apps/${app}/${f}`),
);

const SOURCES = new Map(DOCKERFILES.map((f) => [f, readFileSync(join(ROOT, f), 'utf-8')]));

function manifestCopyLines(dockerfile: string, pkg: string): string[] {
  const re = new RegExp(`^COPY (?:--from=\\S+ )?\\S*packages/${pkg}/package\\.json \\./packages/${pkg}/$`, 'gm');
  return dockerfile.match(re) ?? [];
}

describe('Dockerfile workspace manifest COPY blocks', () => {
  it('derives a non-trivial inventory (guards the test against an empty walk)', () => {
    expect(WORKSPACE_PACKAGES).toEqual(expect.arrayContaining(['db', 'lib', 'editor']));
    expect(DOCKERFILES.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of DOCKERFILES) {
    it(`given ${file}, should copy every packages/* manifest wherever it copies packages/lib/package.json, in the same form`, () => {
      const dockerfile = SOURCES.get(file)!;
      const libSites = manifestCopyLines(dockerfile, 'lib');
      expect(libSites.length, `${file} has no lib manifest COPY — test assumptions broken`).toBeGreaterThan(0);
      for (const pkg of WORKSPACE_PACKAGES) {
        const sites = manifestCopyLines(dockerfile, pkg).map((l) => l.replaceAll(`packages/${pkg}/`, 'packages/lib/'));
        expect(sites, `${file}: packages/${pkg}/package.json COPY lines`).toEqual(libSites);
      }
    });
  }
});
