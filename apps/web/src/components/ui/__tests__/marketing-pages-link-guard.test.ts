/**
 * /terms, /privacy, /cookies and /subprocessors are served by the marketing app on
 * the same host. A plain Next <Link> to them loads the marketing site (with its
 * Pricing nav) inside the native app's web view — link them with MarketingLink.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../..');
const MARKETING_LINK = /<Link\s+href=["'](\/terms|\/privacy|\/cookies|\/subprocessors)["']/;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : walk(path);
    return path.endsWith('.tsx') ? [path] : [];
  });

describe('marketing pages are never linked with next/link', () => {
  it('given any app source file, should link legal pages with MarketingLink', () => {
    const offenders = walk(SRC).filter((file) => MARKETING_LINK.test(readFileSync(file, 'utf8')));
    expect(offenders.map((f) => f.slice(SRC.length + 1))).toEqual([]);
  });
});
