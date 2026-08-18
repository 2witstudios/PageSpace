import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MARKETING_SRC = join(REPO_ROOT, 'apps/marketing/src');

/**
 * The docs and blog moved to their own hosts (docs.pagespace.ai /
 * blog.pagespace.ai) and their routes were deleted from this app. A bare
 * `/docs/...` or `/blog/...` link left behind therefore resolves against
 * pagespace.ai, where nothing serves it — in production it takes the edge 301,
 * and in a standalone or local marketing build it is simply a 404.
 *
 * Three such links survived the first pass in `SecurityPageSections.tsx`
 * (prominent CTAs on the security page), which is why this guard exists:
 * links must go through `docsUrl()` / `blogUrl()` from `@/lib/sites`.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** `href="/docs..."`, `href='/blog...'`, and markdown `](/docs...)`. */
const BARE_LINK = /(?:href=["'`]|\]\()\/(?:docs|blog)(?![a-z0-9-])/gi;

describe('marketing app has no local /docs or /blog links', () => {
  it('routes every docs/blog link through lib/sites helpers', () => {
    const offenders: string[] = [];

    for (const file of walk(MARKETING_SRC)) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      if (file.endsWith(join('lib', 'sites.ts'))) continue; // defines the hosts

      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(BARE_LINK)) {
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${relative(REPO_ROOT, file)}:${line} → ${match[0]}`);
      }
    }

    expect(offenders, `Use docsUrl()/blogUrl() from @/lib/sites instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('actually detects a bare link (guard is not vacuous)', () => {
    const sample = '<Link href="/docs/security">x</Link> and [a](/blog/post)';
    expect([...sample.matchAll(BARE_LINK)]).toHaveLength(2);
  });

  it('does not flag the absolute URLs the helpers produce', () => {
    const sample = 'href={docsUrl("/security")} href="https://docs.pagespace.ai/security"';
    expect([...sample.matchAll(BARE_LINK)]).toHaveLength(0);
  });
});
