import { describe, it, expect } from 'vitest';
import { creditDeniedError, runSkipReason, automationRunState } from '../automation-run-record';

describe('the run record of a refused automation', () => {
  it('SPEND-6 (partial) the denied-run text reads back to the gate reason it was written from', () => {
    expect(creditDeniedError('source_refused', { source: 'drive_wallet', reason: 'creator_departed', options: [] }))
      .toBe('AI credit gate denied: source_refused (creator_departed)');
    for (const reason of ['creator_departed', 'drive_wallet_empty', 'drive_wallet_paused', 'no_drive_wallet', 'source_cap_reached'] as const) {
      expect(runSkipReason(creditDeniedError('source_refused', { source: 'drive_wallet', reason, options: [] }))).toBe(reason);
    }
  });

  it('SPEND-6 (partial) a denial with no refusal, or any other error, has no skip reason', () => {
    expect(runSkipReason(creditDeniedError('out_of_credits'))).toBeNull();
    expect(runSkipReason('Model timed out')).toBeNull();
    expect(runSkipReason(null)).toBeNull();
    expect(runSkipReason('AI credit gate denied: source_refused (drop table)')).toBeNull();
    expect(runSkipReason('AI credit gate denied: source_refused (not_a_reason)')).toBeNull();
  });
});

describe('automationRunState: what a workflow or trigger row shows', () => {
  it('SPEND-6 (partial) an automation whose creator left the org is disabled and flagged owner-left, whatever its last run said (D-OW-36)', () => {
    expect(automationRunState({ ownerLeftAt: '2026-09-30T00:00:00Z', lastRunStatus: 'success', lastRunError: null })).toEqual({ kind: 'owner_left' });
  });

  it('SPEND-6 (partial) a run skipped for spend or a departed creator shows as skipped with its reason', () => {
    expect(automationRunState({ ownerLeftAt: null, lastRunStatus: 'cancelled', lastRunError: 'AI credit gate denied: source_refused (creator_departed)' }))
      .toEqual({ kind: 'skipped', reason: 'creator_departed' });
    expect(automationRunState({ ownerLeftAt: null, lastRunStatus: 'error', lastRunError: 'AI credit gate denied: source_refused (source_cap_reached)' }))
      .toEqual({ kind: 'skipped', reason: 'source_cap_reached' });
  });

  it('SPEND-6 (partial) any other run is its plain status', () => {
    expect(automationRunState({ ownerLeftAt: null, lastRunStatus: 'error', lastRunError: 'Model timed out' })).toEqual({ kind: 'normal' });
    expect(automationRunState({ ownerLeftAt: null, lastRunStatus: null, lastRunError: null })).toEqual({ kind: 'normal' });
  });
});
