/**
 * Pure-core tests for the stuck-page reconciler (#2159).
 *
 * classifyStalePage is the decision function: given the evidence gathered
 * about one stuck page (status, age, live-job existence, prior reconcile
 * attempts, content-hash validity) and the policy (staleness threshold, max
 * attempts), it decides skip / re-enqueue / fail. All branches covered here.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyStalePage,
  resolveReconcilerPolicy,
  DEFAULT_STALE_THRESHOLD_MS,
  DEFAULT_MAX_RECONCILE_ATTEMPTS,
  DEFAULT_BATCH_LIMIT,
  type StalePageEvidence,
  type ReconcilerPolicy,
} from '../stuck-page-reconciler-core';

const POLICY: ReconcilerPolicy = {
  staleThresholdMs: 15 * 60 * 1000,
  maxReconcileAttempts: 3,
  batchLimit: 50,
};

function evidence(overrides: Partial<StalePageEvidence> = {}): StalePageEvidence {
  return {
    pageId: 'page_1',
    processingStatus: 'pending',
    statusAgeMs: 60 * 60 * 1000, // 1h — stale under POLICY
    hasLiveJob: false,
    priorReconcileAttempts: 0,
    hasValidContentHash: true,
    ...overrides,
  };
}

describe('classifyStalePage', () => {
  it('skips when a live pg-boss job exists for the page', () => {
    expect(classifyStalePage(evidence({ hasLiveJob: true }), POLICY)).toEqual({
      action: 'skip',
      reason: 'live-job',
    });
  });

  it('live-job wins even when the page is also out of attempts', () => {
    expect(
      classifyStalePage(evidence({ hasLiveJob: true, priorReconcileAttempts: 99 }), POLICY),
    ).toEqual({ action: 'skip', reason: 'live-job' });
  });

  it('skips when the page is younger than the staleness threshold', () => {
    expect(
      classifyStalePage(evidence({ statusAgeMs: POLICY.staleThresholdMs - 1 }), POLICY),
    ).toEqual({ action: 'skip', reason: 'not-stale' });
  });

  it('treats exactly-at-threshold age as stale', () => {
    const decision = classifyStalePage(evidence({ statusAgeMs: POLICY.staleThresholdMs }), POLICY);
    expect(decision.action).toBe('reenqueue');
  });

  it('re-enqueues a stale pending page with no live job, tagging attempt 1', () => {
    expect(classifyStalePage(evidence(), POLICY)).toEqual({ action: 'reenqueue', attempt: 1 });
  });

  it('re-enqueues a stale processing page (crashed worker, expired job)', () => {
    expect(classifyStalePage(evidence({ processingStatus: 'processing' }), POLICY)).toEqual({
      action: 'reenqueue',
      attempt: 1,
    });
  });

  it('increments the attempt tag past prior reconcile attempts', () => {
    expect(classifyStalePage(evidence({ priorReconcileAttempts: 2 }), POLICY)).toEqual({
      action: 'reenqueue',
      attempt: 3,
    });
  });

  it('fails the page once reconcile attempts are exhausted', () => {
    const decision = classifyStalePage(evidence({ priorReconcileAttempts: 3 }), POLICY);
    expect(decision.action).toBe('fail');
    if (decision.action !== 'fail') throw new Error('unreachable');
    expect(decision.reason).toBe('attempts-exhausted');
    expect(decision.message).toContain('3');
  });

  it('fails immediately when maxReconcileAttempts is 0', () => {
    const decision = classifyStalePage(evidence(), { ...POLICY, maxReconcileAttempts: 0 });
    expect(decision.action).toBe('fail');
    if (decision.action !== 'fail') throw new Error('unreachable');
    expect(decision.reason).toBe('attempts-exhausted');
  });

  it('fails a stale page whose content hash is missing or invalid — it can never be re-enqueued', () => {
    const decision = classifyStalePage(evidence({ hasValidContentHash: false }), POLICY);
    expect(decision.action).toBe('fail');
    if (decision.action !== 'fail') throw new Error('unreachable');
    expect(decision.reason).toBe('missing-content-hash');
    expect(decision.message.length).toBeGreaterThan(0);
  });

  it('missing-content-hash is checked before attempt exhaustion (message says why it can never work)', () => {
    const decision = classifyStalePage(
      evidence({ hasValidContentHash: false, priorReconcileAttempts: 99 }),
      POLICY,
    );
    expect(decision).toMatchObject({ action: 'fail', reason: 'missing-content-hash' });
  });
});

describe('resolveReconcilerPolicy', () => {
  it('returns documented defaults for an empty env', () => {
    expect(resolveReconcilerPolicy({})).toEqual({
      staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
      maxReconcileAttempts: DEFAULT_MAX_RECONCILE_ATTEMPTS,
      batchLimit: DEFAULT_BATCH_LIMIT,
    });
  });

  it('reads RECONCILER_STALE_MINUTES / RECONCILER_MAX_ATTEMPTS / RECONCILER_BATCH_LIMIT', () => {
    expect(
      resolveReconcilerPolicy({
        RECONCILER_STALE_MINUTES: '30',
        RECONCILER_MAX_ATTEMPTS: '5',
        RECONCILER_BATCH_LIMIT: '10',
      }),
    ).toEqual({ staleThresholdMs: 30 * 60 * 1000, maxReconcileAttempts: 5, batchLimit: 10 });
  });

  it('falls back to defaults for non-numeric values', () => {
    expect(
      resolveReconcilerPolicy({
        RECONCILER_STALE_MINUTES: 'soon',
        RECONCILER_MAX_ATTEMPTS: 'lots',
        RECONCILER_BATCH_LIMIT: 'many',
      }),
    ).toEqual({
      staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
      maxReconcileAttempts: DEFAULT_MAX_RECONCILE_ATTEMPTS,
      batchLimit: DEFAULT_BATCH_LIMIT,
    });
  });

  it('falls back to defaults for zero/negative values (a zero batch would scan nothing forever)', () => {
    expect(
      resolveReconcilerPolicy({
        RECONCILER_STALE_MINUTES: '0',
        RECONCILER_MAX_ATTEMPTS: '-1',
        RECONCILER_BATCH_LIMIT: '0',
      }),
    ).toEqual({
      staleThresholdMs: DEFAULT_STALE_THRESHOLD_MS,
      maxReconcileAttempts: DEFAULT_MAX_RECONCILE_ATTEMPTS,
      batchLimit: DEFAULT_BATCH_LIMIT,
    });
  });
});
