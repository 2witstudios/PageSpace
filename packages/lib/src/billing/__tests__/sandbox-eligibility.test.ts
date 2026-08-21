import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  SANDBOX_ELIGIBLE_TIERS,
  TENANT_EFFECTIVE_SANDBOX_TIER,
  isSandboxAvailable,
  isSandboxTierEligible,
  resolveEffectiveSandboxTier,
  resolveEffectiveSandboxTierForMode,
} from '../sandbox-eligibility';
import { TIERS, type SubscriptionTier } from '../subscription-tiers';
import type { DeploymentMode } from '../../deployment-mode';

const ALL_TIERS: readonly SubscriptionTier[] = TIERS;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isSandboxTierEligible — the pure price-list predicate', () => {
  it('is the tier table, and nothing else', () => {
    for (const tier of ALL_TIERS) {
      expect(isSandboxTierEligible(tier)).toBe(SANDBOX_ELIGIBLE_TIERS.includes(tier));
    }
    expect(isSandboxTierEligible('free')).toBe(false);
  });

  it('does not move with deployment mode — a price list describes the plan, not the process', () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'tenant');
    expect(isSandboxTierEligible('free')).toBe(false);
  });
});

describe('resolveEffectiveSandboxTierForMode — the single seam', () => {
  it('leaves the stored tier alone on cloud', () => {
    for (const tier of ALL_TIERS) {
      expect(resolveEffectiveSandboxTierForMode(tier, 'cloud')).toBe(tier);
    }
  });

  it('leaves the stored tier alone on onprem — onprem is deliberately NOT exempt', () => {
    for (const tier of ALL_TIERS) {
      expect(resolveEffectiveSandboxTierForMode(tier, 'onprem')).toBe(tier);
    }
    // The whole point, stated as a fact rather than an absence: a free-tier
    // onprem payer is still refused, because onprem's answer to code execution
    // is a local shell bridge, not a Sprite this deployment can reach.
    expect(isSandboxTierEligible(resolveEffectiveSandboxTierForMode('free', 'onprem'))).toBe(false);
  });

  it('normalizes every stored tier to the tenant effective tier on tenant', () => {
    for (const tier of ALL_TIERS) {
      expect(resolveEffectiveSandboxTierForMode(tier, 'tenant')).toBe(TENANT_EFFECTIVE_SANDBOX_TIER);
    }
  });

  it('is idempotent, so a gate may normalize defensively without changing the answer', () => {
    for (const mode of ['cloud', 'tenant', 'onprem'] as DeploymentMode[]) {
      for (const tier of ALL_TIERS) {
        const once = resolveEffectiveSandboxTierForMode(tier, mode);
        expect(resolveEffectiveSandboxTierForMode(once, mode)).toBe(once);
      }
    }
  });

  it('resolves to an ELIGIBLE tier on tenant — a bypass that lands on an ineligible tier is no bypass', () => {
    expect(isSandboxTierEligible(TENANT_EFFECTIVE_SANDBOX_TIER)).toBe(true);
  });

  it('keeps a real ceiling on tenant rather than an unlimited sentinel', () => {
    expect(ALL_TIERS).toContain(TENANT_EFFECTIVE_SANDBOX_TIER);
  });
});

describe('resolveEffectiveSandboxTier — the env-reading edge', () => {
  it('reads DEPLOYMENT_MODE, and treats anything unrecognized as cloud', () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'tenant');
    expect(resolveEffectiveSandboxTier('free')).toBe(TENANT_EFFECTIVE_SANDBOX_TIER);

    vi.stubEnv('DEPLOYMENT_MODE', 'onprem');
    expect(resolveEffectiveSandboxTier('free')).toBe('free');

    vi.stubEnv('DEPLOYMENT_MODE', '');
    expect(resolveEffectiveSandboxTier('free')).toBe('free');

    vi.stubEnv('DEPLOYMENT_MODE', 'Tenant');
    expect(resolveEffectiveSandboxTier('free')).toBe('free');
  });
});

describe('isSandboxAvailable — the gate', () => {
  it('is unchanged on cloud: paid tiers only', () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
    expect(isSandboxAvailable('free')).toBe(false);
    expect(isSandboxAvailable('pro')).toBe(true);
    expect(isSandboxAvailable('founder')).toBe(true);
    expect(isSandboxAvailable('business')).toBe(true);
  });

  it('is unchanged with DEPLOYMENT_MODE unset (the cloud default)', () => {
    vi.stubEnv('DEPLOYMENT_MODE', undefined);
    expect(isSandboxAvailable('free')).toBe(false);
    expect(isSandboxAvailable('pro')).toBe(true);
  });

  it('grants every tier on tenant — including the seeded default `free`', () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'tenant');
    for (const tier of ALL_TIERS) {
      expect(isSandboxAvailable(tier)).toBe(true);
    }
  });

  it('still refuses free on onprem', () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'onprem');
    expect(isSandboxAvailable('free')).toBe(false);
    expect(isSandboxAvailable('pro')).toBe(true);
  });
});

/**
 * Sweep: the seam is only a seam while it is the ONLY place the question is
 * asked. These scan the repo's source rather than a module graph, because what
 * regresses is a future edit reaching for the raw tier table (or writing its own
 * `isTenantMode()` branch beside a tier read) — exactly what a unit test of the
 * current call sites cannot see.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const SCAN_DIRS = [
  'packages/lib/src',
  'apps/web/src',
  'apps/realtime/src',
  'apps/marketing/src',
  'apps/processor/src',
];

/**
 * Comments stripped everywhere the sweep looks: these modules DOCUMENT the rule
 * at length, naming the very identifiers being swept for, and a sweep that reads
 * prose as code fails on its own explanation.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = [];
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a scanned app may not exist in a partial checkout
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
      const child = `${dir}/${entry.name}`;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child, childRel);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push({ path: childRel.slice(1), src: stripComments(readFileSync(child, 'utf8')) });
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(`${REPO_ROOT}${dir}`, `/${dir}`);
  return out;
}

/** Two separate questions, deliberately not one alternation: mixing an anchored
 *  branch with an unanchored one reads as a precedence bug (and CodeQL flags it). */
function isTestPath(path: string): boolean {
  return path.includes('/__tests__/') || /\.test\.tsx?$/.test(path);
}

function nonTestFiles() {
  return sourceFiles().filter(({ path }) => !isTestPath(path));
}

describe('eligibility sweep — one place decides', () => {
  it('finds source to scan at all (a silently empty sweep proves nothing)', () => {
    expect(nonTestFiles().length).toBeGreaterThan(500);
  });

  it('no gate reads the raw tier table: SANDBOX_ELIGIBLE_TIERS is referenced only where it is defined', () => {
    const offenders = nonTestFiles()
      .filter(({ src }) => src.includes('SANDBOX_ELIGIBLE_TIERS'))
      .map(({ path }) => path);
    expect(offenders).toEqual(['packages/lib/src/billing/sandbox-eligibility.ts']);
  });

  it('the pure predicate is used only by the price list, never by a gate', () => {
    const offenders = nonTestFiles()
      .filter(({ src }) => src.includes('isSandboxTierEligible'))
      .map(({ path }) => path)
      .sort();
    expect(offenders).toEqual([
      'apps/marketing/src/app/pricing/page.tsx',
      'packages/lib/src/billing/sandbox-eligibility.ts',
    ]);
  });

  it('no sandbox/env/quota module branches on deployment mode beside a tier read', () => {
    const offenders = nonTestFiles()
      .filter(({ path }) => /\/(sandbox|drive-envs|agent-workspaces)\//.test(path))
      .filter(({ src }) => /\bisTenantMode\s*\(|\bisCloud\s*\(|\bgetDeploymentMode\s*\(/.test(src))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('the tier-indexed ceiling tables are only ever indexed by the EFFECTIVE tier', () => {
    const quota = stripComments(
      readFileSync(`${REPO_ROOT}packages/lib/src/services/sandbox/quota.ts`, 'utf8'),
    );
    for (const table of ['CONCURRENCY_LIMITS', 'DRIVE_ENV_LIMITS']) {
      const lookups = [...quota.matchAll(new RegExp(`${table}\\[([^\\]]*)\\]`, 'g'))].map((m) => m[1]);
      expect(lookups.length).toBeGreaterThan(0);
      expect(lookups).toEqual(lookups.map(() => 'resolveEffectiveSandboxTier(tier)'));
    }
  });
});
