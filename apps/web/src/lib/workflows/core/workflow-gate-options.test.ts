import { describe, it, expect } from 'vitest';
import { workflowGateOptions } from './workflow-gate-options';

const EST = 7;
const INFLIGHT = 8;
const base = { holdEstimateCents: EST, maxInteractiveInFlight: INFLIGHT };

describe('workflowGateOptions', () => {
  it('given a chain with no ai step, should take no gate (null)', () => {
    expect(
      workflowGateOptions({ ...base, sourceTable: 'cron', aiStepCount: 0, policy: undefined }),
    ).toBe(null);
  });

  it('given a manual run, should size the hold by ai steps and cap concurrency (interactive)', () => {
    expect(
      workflowGateOptions({ ...base, sourceTable: 'manual', aiStepCount: 3, policy: undefined }),
    ).toEqual({ estCostCents: 21, maxInFlight: INFLIGHT });
  });

  it('given a scheduled run with no caller policy, should size the hold and apply the daily cap (fail-safe default)', () => {
    expect(
      workflowGateOptions({ ...base, sourceTable: 'cron', aiStepCount: 1, policy: undefined }),
    ).toEqual({ estCostCents: EST });
  });

  it('given a caller policy that skips the daily cap, should pass it through', () => {
    expect(
      workflowGateOptions({
        ...base,
        sourceTable: 'calendarTriggers',
        aiStepCount: 1,
        policy: { skipDailyCap: true },
      }),
    ).toEqual({ estCostCents: EST, skipDailyCap: true });
  });

  it('given a caller daily ceiling, should pass it through without skipping the tier cap', () => {
    expect(
      workflowGateOptions({
        ...base,
        sourceTable: 'webhookTriggers',
        aiStepCount: 2,
        policy: { dailyCapCeilingCents: 500 },
      }),
    ).toEqual({ estCostCents: 14, dailyCapCeilingCents: 500 });
  });

  it('given a manual run with a caller policy, should never let the policy drop the interactive concurrency cap', () => {
    expect(
      workflowGateOptions({
        ...base,
        sourceTable: 'manual',
        aiStepCount: 1,
        policy: { skipDailyCap: true },
      }),
    ).toEqual({ estCostCents: EST, maxInFlight: INFLIGHT, skipDailyCap: true });
  });
});
