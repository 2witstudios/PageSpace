import { describe, it, expect } from 'vitest';
import {
  ERASURE_STEPS,
  buildErasurePlan,
  classifyErasureError,
  isRetryable,
  MAX_ERASURE_ATTEMPTS,
} from '../erasure-plan';

/** CH not in play unless a test says otherwise. */
const cloudPlan = () => buildErasurePlan({ deploymentMode: 'cloud', clickHouseInPlay: false });

describe('buildErasurePlan', () => {
  it('given cloud mode, should include sub-processor propagation steps in a stable order', () => {
    const plan = cloudPlan();
    const ids = plan.map((s) => s.id);
    // drive disposition must come before user deletion; user deletion is last-ish.
    expect(ids.indexOf('drive-disposition')).toBeLessThan(ids.indexOf('delete-user'));
    expect(ids).toContain('email-suppression');
    expect(ids).toContain('ai-provider-erasure');
    expect(ids).toContain('stripe-customer');
  });

  it('given on-prem mode, should omit cloud-only sub-processor steps', () => {
    const plan = buildErasurePlan({ deploymentMode: 'onprem', clickHouseInPlay: false });
    const ids = plan.map((s) => s.id);
    expect(ids).not.toContain('email-suppression');
    expect(ids).not.toContain('ai-provider-erasure');
    expect(ids).not.toContain('stripe-customer');
    // Core local erasure still happens.
    expect(ids).toContain('delete-user');
    expect(ids).toContain('anonymize-activity-logs');
  });

  it('drive disposition is fatal; sub-processor propagation is best-effort', () => {
    const plan = cloudPlan();
    const drive = plan.find((s) => s.id === 'drive-disposition');
    const email = plan.find((s) => s.id === 'email-suppression');
    expect(drive?.fatal).toBe(true);
    expect(email?.fatal).toBe(false);
  });

  it('runs ai-provider-erasure BEFORE purge-ai-usage (manifest reads ai_usage rows)', () => {
    const ids = cloudPlan().map((s) => s.id);
    expect(ids.indexOf('ai-provider-erasure')).toBeLessThan(ids.indexOf('purge-ai-usage'));
  });

  it('every step id is unique', () => {
    const plan = cloudPlan();
    const ids = plan.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('purge-monitoring fatality (#890 Phase 3 FIX — CH purge failure must not complete the run)', () => {
    it('given ClickHouse NOT in play, purge-monitoring stays best-effort (pre-existing PG-only behavior)', () => {
      const step = cloudPlan().find((s) => s.id === 'purge-monitoring');
      expect(step?.fatal).toBe(false);
    });

    it('given ClickHouse in play, purge-monitoring is FATAL — error_logs has no TTL, so a swallowed CH purge failure retains the subject rows forever under a completed run', () => {
      const step = buildErasurePlan({ deploymentMode: 'cloud', clickHouseInPlay: true })
        .find((s) => s.id === 'purge-monitoring');
      expect(step?.fatal).toBe(true);
    });

    it('given ClickHouse in play on-prem, purge-monitoring is fatal there too', () => {
      const step = buildErasurePlan({ deploymentMode: 'onprem', clickHouseInPlay: true })
        .find((s) => s.id === 'purge-monitoring');
      expect(step?.fatal).toBe(true);
    });

    it('given ClickHouse in play, only purge-monitoring gains fatality — other best-effort steps are unchanged', () => {
      const plan = buildErasurePlan({ deploymentMode: 'cloud', clickHouseInPlay: true });
      expect(plan.find((s) => s.id === 'email-suppression')?.fatal).toBe(false);
      expect(plan.find((s) => s.id === 'purge-ai-usage')?.fatal).toBe(false);
      expect(plan.find((s) => s.id === 'security-audit')?.fatal).toBe(false);
    });
  });

  it('exposes the canonical step list', () => {
    expect(ERASURE_STEPS).toContain('delete-user');
  });
});

describe('classifyErasureError / isRetryable', () => {
  it('given a transient network/db error, should be retryable', () => {
    expect(classifyErasureError(new Error('ECONNRESET while talking to db')).retryable).toBe(true);
    expect(classifyErasureError(new Error('connection timeout')).retryable).toBe(true);
    expect(classifyErasureError(new Error('deadlock detected')).retryable).toBe(true);
  });

  it('given a blocked (multi-member) sentinel, should NOT be retryable — needs human escalation', () => {
    const result = classifyErasureError(new Error('ERASURE_BLOCKED: multi-member drives'));
    expect(result.retryable).toBe(false);
    expect(result.terminalReason).toBe('blocked');
  });

  it('given an unknown error, should default to retryable (durable queue will cap attempts)', () => {
    expect(classifyErasureError(new Error('something weird')).retryable).toBe(true);
  });

  it('isRetryable should stop retrying once attempts reach the cap', () => {
    expect(isRetryable(new Error('ECONNRESET'), MAX_ERASURE_ATTEMPTS - 1)).toBe(true);
    expect(isRetryable(new Error('ECONNRESET'), MAX_ERASURE_ATTEMPTS)).toBe(false);
  });
});
