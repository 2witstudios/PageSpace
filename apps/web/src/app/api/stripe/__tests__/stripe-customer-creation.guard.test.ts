/**
 * Source guard (ADR 0007 Decision 8, Agent Signup Phase 1b): an agent never
 * holds its own Stripe customer. Every file in the monorepo that calls
 * `customers.create(` must be one of the enumerated sites, and each of those
 * must refuse an agent BEFORE the create call. A new customer-creation path
 * fails this guard until it goes through `getOrCreateStripeCustomer` (or adds
 * the refusal and is listed here).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// vitest runs with cwd = apps/web.
const REPO = join(process.cwd(), '../..');
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'dist', '.next', 'coverage']);

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const repoRel = (file: string) => relative(REPO, file).split(sep).join('/');

const ROOTS = [
  ...readdirSync(join(REPO, 'apps')).map((app) => join(REPO, 'apps', app, 'src')),
  ...readdirSync(join(REPO, 'packages')).map((pkg) => join(REPO, 'packages', pkg, 'src')),
];

/** Each allowed creation site, and the refusal that must precede its create call. */
const GUARDED_SITES: Record<string, string> = {
  'apps/web/src/lib/stripe-customer.ts': 'assertMayHoldStripeCustomer(user)',
  'apps/admin/src/lib/stripe-customer.ts': 'assertMayHoldStripeCustomer(user)',
  'apps/web/src/app/api/stripe/billing-address/route.ts': 'assertMayHoldStripeCustomer(user)',
  'apps/web/src/app/api/stripe/customer/route.ts': "user.accountType === 'agent'",
};

describe('Stripe customer creation guard', () => {
  const creators = ROOTS.flatMap(sourceFiles)
    .filter((file) => readFileSync(file, 'utf8').includes('customers.create('))
    .map(repoRel)
    .sort();

  it('found the guarded helpers (the scan is reading the monorepo)', () => {
    expect(creators).toContain('apps/web/src/lib/stripe-customer.ts');
    expect(creators).toContain('apps/admin/src/lib/stripe-customer.ts');
  });

  it('no file creates a Stripe customer outside the enumerated agent-refusing sites', () => {
    expect(creators).toEqual(Object.keys(GUARDED_SITES).sort());
  });

  it('every enumerated site refuses an agent before EACH of its customers.create calls', () => {
    const offenders = Object.entries(GUARDED_SITES).filter(([rel, refusal]) => {
      const src = readFileSync(join(REPO, rel), 'utf8');
      const refusalAt = src.indexOf(refusal);
      if (refusalAt === -1) return true;
      // Every create call, not just the first: a second, later call added below an
      // early refusal is still preceded by it, but one added ABOVE it is not.
      for (let at = src.indexOf('customers.create('); at !== -1; at = src.indexOf('customers.create(', at + 1)) {
        if (at < refusalAt) return true;
      }
      return false;
    });
    expect(offenders.map(([rel]) => rel)).toEqual([]);
  });

  /**
   * Linking an existing customer id to a users row is the other way an agent
   * could end up holding a Stripe customer (the checkout webhook once linked by
   * email alone). Every non-null stripeCustomerId write must sit in a listed
   * site, after that site's agent refusal. Clearing it to null is always fine.
   */
  const WRITE_SITES: Record<string, string> = {
    ...GUARDED_SITES,
    // The human-only WHERE (eq(users.accountType, 'human')) follows the set; the route test pins it.
    'apps/web/src/app/api/stripe/webhook/route.ts': '!isAgentReservedEmail(customerEmail)',
  };
  const NON_NULL_WRITE = /\.(?:set|values)\(\s*\{[^()]*?\bstripeCustomerId\s*:\s*(?!\s|null\b)/g;
  const writeOffsets = (src: string): number[] => [...src.matchAll(NON_NULL_WRITE)].map((m) => m.index ?? 0);

  it('no file writes a non-null stripeCustomerId outside the listed agent-refusing sites', () => {
    const writers = ROOTS.flatMap(sourceFiles)
      .filter((file) => writeOffsets(readFileSync(file, 'utf8')).length > 0)
      .map(repoRel)
      .sort();
    expect(writers).toEqual(Object.keys(WRITE_SITES).sort());
  });

  it('every listed site refuses an agent before EACH non-null stripeCustomerId write', () => {
    const offenders = Object.entries(WRITE_SITES).filter(([rel, refusal]) => {
      const src = readFileSync(join(REPO, rel), 'utf8');
      const refusalAt = src.indexOf(refusal);
      return refusalAt === -1 || writeOffsets(src).some((at) => at < refusalAt);
    });
    expect(offenders.map(([rel]) => rel)).toEqual([]);
  });
});
