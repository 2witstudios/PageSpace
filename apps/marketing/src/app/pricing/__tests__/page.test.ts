import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * MON-2 regression guard (independent-review finding on #2649): the pricing page has
 * no dynamic API usage and no `dynamic`/`revalidate` export originally, so Next.js
 * prerenders it once at `next build` time — inside the Docker builder stage, where
 * MONEY_MODEL_V2 is never set (absent from apps/marketing/Dockerfile and
 * .github/workflows/docker-images.yml) — and serves that static HTML forever. A
 * migration-day flip of the flag would never reach this page's `creditsPhrase` /
 * `includedCreditsPhrase` copy: the exact promise-vs-grant mismatch #2643 reported,
 * now on the public page a subscriber actually bought from.
 *
 * A source-text check (not a module import) so it runs in a worktree with no
 * packages/lib dist build — see money-model.ts's own money-model-guard.test.ts for
 * the same tradeoff on the lib side.
 */
const pageSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../page.tsx'),
  'utf8',
);

// Active (non-comment) lines only, so a `// export const revalidate = …` left behind
// by a revert can't fool the guard — the whole point is that the export actually runs.
const activeLines = pageSource
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
const activeSource = activeLines.join('\n');

describe('MON-2 pricing page revalidates instead of staying statically frozen at build time', () => {
  it('the guard ignores a commented-out export (proves it checks active code, not just text presence)', () => {
    const commentedOut = pageSource.replace(
      /export const revalidate = 3600;/,
      '// export const revalidate = 3600;',
    );
    const stillActive = commentedOut
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n');
    expect(/export const revalidate\s*=\s*\d+/.test(stillActive)).toBe(false);
  });

  it('exports revalidate (or force-dynamic) so a MONEY_MODEL_V2 flip reaches this page without a marketing rebuild', () => {
    const revalidateMatch = activeSource.match(/export const revalidate\s*=\s*(\d+)/);
    const isForceDynamic = /export const dynamic\s*=\s*['"]force-dynamic['"]/.test(activeSource);
    expect(revalidateMatch !== null || isForceDynamic).toBe(true);
    if (revalidateMatch) {
      const seconds = Number(revalidateMatch[1]);
      // Bounded: long enough to still get real caching benefit, short enough that a
      // migration-day flag flip reaches the public page same-day, not "eventually".
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(24 * 60 * 60);
    }
  });
});
