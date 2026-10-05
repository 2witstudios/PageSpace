/**
 * Every Dockerfile that installs the monorepo copies each workspace's
 * package.json BEFORE `bun install --frozen-lockfile`, because the lockfile
 * names every workspace and the install fails if one manifest is missing.
 * That failure surfaces ONLY at image-build time — never in local dev, never
 * in CI's typecheck/test jobs — so a new workspace package silently breaks
 * every deploy unless every manifest block gains a COPY line for it.
 *
 * Both inventories are derived, not hand-listed: the workspaces from
 * `packages/*` and `apps/*` on disk, the Dockerfiles from `apps/* /Dockerfile*`.
 * A new workspace (apps/imago was the first app added after this guard) or a
 * new Dockerfile is therefore covered the moment it exists.
 * `packages/lib` is the reference: wherever it is copied, every other
 * workspace must be copied in the same form (plain, or `--from=<stage>` in a
 * runner stage that re-installs), the same number of times.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../..');

const workspacesIn = (parent: 'packages' | 'apps'): string[] =>
  readdirSync(join(ROOT, parent))
    .filter((dir) => existsSync(join(ROOT, parent, dir, 'package.json')))
    .map((dir) => `${parent}/${dir}`);

const WORKSPACES = [...workspacesIn('packages'), ...workspacesIn('apps')];

const DOCKERFILES = readdirSync(join(ROOT, 'apps')).flatMap((app) =>
  readdirSync(join(ROOT, 'apps', app))
    .filter((f) => f.startsWith('Dockerfile'))
    .map((f) => `apps/${app}/${f}`),
);

const SOURCES = new Map(DOCKERFILES.map((f) => [f, readFileSync(join(ROOT, f), 'utf-8')]));

function manifestCopyLines(dockerfile: string, workspace: string): string[] {
  const re = new RegExp(`^COPY (?:--from=\\S+ )?\\S*${workspace}/package\\.json \\./${workspace}/$`, 'gm');
  return dockerfile.match(re) ?? [];
}

describe('Dockerfile workspace manifest COPY blocks', () => {
  it('derives a non-trivial inventory (guards the test against an empty walk)', () => {
    expect(WORKSPACES).toEqual(
      expect.arrayContaining(['packages/db', 'packages/lib', 'packages/editor', 'apps/web', 'apps/imago']),
    );
    expect(DOCKERFILES.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of DOCKERFILES) {
    it(`given ${file}, should copy every packages/* and apps/* manifest wherever it copies packages/lib/package.json, in the same form`, () => {
      const dockerfile = SOURCES.get(file)!;
      const libSites = manifestCopyLines(dockerfile, 'packages/lib');
      expect(libSites.length, `${file} has no lib manifest COPY — test assumptions broken`).toBeGreaterThan(0);
      for (const workspace of WORKSPACES) {
        const sites = manifestCopyLines(dockerfile, workspace).map((l) => l.replaceAll(`${workspace}/`, 'packages/lib/'));
        expect(sites, `${file}: ${workspace}/package.json COPY lines`).toEqual(libSites);
      }
    });
  }
});
