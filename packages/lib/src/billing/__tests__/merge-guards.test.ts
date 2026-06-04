/**
 * Merge guards over the billing layer's structural invariants. Source-scan assertions
 * that fail the build when a regression breaks a property the runtime depends on but that
 * no single unit test would catch — the gate using NET balance, the daily cap living at
 * the one choke point, the reconcile correction staying idempotent.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('billing merge guards', () => {
  it('the gate decision subtracts debt (NET balance), so an in-debt user is denied', () => {
    const core = read('../credit-core.ts');
    // evaluateGate's spendable must net out debt; without the `- debt` term a user in the
    // red could keep spending. (The displayed balance is intentionally GROSS — see below.)
    const gate = core.slice(core.indexOf('export function evaluateGate'));
    expect(gate).toMatch(/spendable\s*=[^;]*-\s*debt/);
  });

  it('the displayed balance is GROSS of holds (display ≠ gate)', () => {
    // The gate subtracts reserved holds from spendable; the display must NOT, or the
    // navbar would dip on call start and pop back at settle (the flicker we removed).
    const balance = read('../credit-balance.ts');
    expect(balance).not.toMatch(/-\s*reserved/);
  });

  it('the per-user/day exposure cap is enforced at the single gate choke point', () => {
    const gate = read('../credit-gate.ts');
    // Every AI route funnels through canConsumeAI (proven by the web call-site guard), so
    // checking evaluateDailyCap is wired here covers all entry points at once.
    expect(gate).toMatch(/evaluateDailyCap\(/);
    // And it must read the configured cap (not a hard-coded number).
    expect(gate).toMatch(/dailyExposureCapForTier\(/);
  });

  it('the reconcile correction is idempotent (onConflictDoNothing on the generation key)', () => {
    const reconcile = read('../cost-reconcile.ts');
    const insert = reconcile.slice(reconcile.indexOf('.insert(creditLedger)'));
    expect(insert).toMatch(/onConflictDoNothing/);
    expect(insert).toMatch(/reconcileGenerationKey/);
  });

  it('the daily-cap sum counts the full intended charge (chargeMillicents, not appliedCents)', () => {
    const gate = read('../credit-gate.ts');
    const capBlock = gate.slice(gate.indexOf('dailyCap !== null'));
    // chargeMillicents is the full charge even when a call went to debt; appliedCents would
    // let an in-debt runaway keep spending real money under the cap.
    expect(capBlock).toMatch(/chargeMillicents/);
    expect(capBlock).not.toMatch(/sum\([^)]*appliedCents/);
  });
});
