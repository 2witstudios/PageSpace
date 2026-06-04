/**
 * Merge guards over the billing layer's structural invariants. Source-scan assertions
 * that fail the build when a regression breaks a property the runtime depends on but that
 * no single unit test would catch.
 *
 * Two former scans have been RETIRED now that real-DB behavioral tests supersede them
 * (they exercise the property instead of grepping for the line that implements it):
 *   - "gate subtracts debt (NET balance)" → evaluateGate's debt subtraction is proven
 *     behaviorally in credit-core.test.ts ("subtracts outstanding debt from spendable",
 *     "treats debt that drags net to/under the floor as out_of_credits").
 *   - "reconcile correction is idempotent (onConflictDoNothing on the generation key)" →
 *     proven behaviorally against real Postgres / the real cron in
 *     cost-reconcile.integration.test.ts (transaction atomicity) and the e2e
 *     13-metering-reconcile.spec.ts (a duplicate generation set + a re-run never
 *     double-correct).
 *
 * What remains here are properties NOT yet covered by a behavioral test: the displayed
 * balance staying gross of holds, and the daily-cap wiring/units at the gate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('billing merge guards', () => {
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

  it('the daily-cap sum counts the full intended charge (chargeMillicents, not appliedCents)', () => {
    const gate = read('../credit-gate.ts');
    const capBlock = gate.slice(gate.indexOf('dailyCap !== null'));
    // chargeMillicents is the full charge even when a call went to debt; appliedCents would
    // let an in-debt runaway keep spending real money under the cap.
    expect(capBlock).toMatch(/chargeMillicents/);
    expect(capBlock).not.toMatch(/sum\([^)]*appliedCents/);
  });
});
