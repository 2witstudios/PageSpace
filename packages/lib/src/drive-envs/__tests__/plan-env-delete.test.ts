import { describe, it, expect } from 'vitest';
import { planEnvDelete, type DriveEnvDeleteRow } from '../plan-env-delete';

const NOW = new Date('2026-08-17T12:00:00.000Z');

function makeRow(over: Partial<DriveEnvDeleteRow> = {}): DriveEnvDeleteRow {
  return { id: 'env-1', sandboxId: null, spriteInstanceId: null, spriteTornDownAt: null, ...over };
}

/** A row that believes it holds a live Sprite — the shape a teardown acts on. */
function liveRow(over: Partial<DriveEnvDeleteRow> = {}): DriveEnvDeleteRow {
  return makeRow({ sandboxId: 'pgs-env-abc', spriteInstanceId: 'inst-1', ...over });
}

describe('planEnvDelete — the live-session guard', () => {
  it('given live sessions and no force, should deny and report the count', () => {
    const plan = planEnvDelete({ row: liveRow(), liveSessionCount: 3, force: false });
    expect(plan).toEqual({ action: 'deny_live_sessions', liveSessionCount: 3 });
  });

  it('given live sessions and force, should proceed to teardown — force is the ONLY thing that passes the guard', () => {
    const plan = planEnvDelete({ row: liveRow(), liveSessionCount: 3, force: true });
    expect(plan).toEqual({ action: 'teardown_then_delete', sandboxId: 'pgs-env-abc', expectedInstanceId: 'inst-1' });
  });

  it('given ZERO live sessions, should proceed without needing force', () => {
    const plan = planEnvDelete({ row: liveRow(), liveSessionCount: 0, force: false });
    expect(plan.action).toBe('teardown_then_delete');
  });

  it('given the guard trips, should decide BEFORE reading any pointer — an env with no Sprite is still refused', () => {
    // The ordering is the invariant: the row delete cascades to live sessions,
    // so "nothing to kill" must never be allowed to short-circuit the guard.
    const plan = planEnvDelete({ row: makeRow(), liveSessionCount: 1, force: false });
    expect(plan).toEqual({ action: 'deny_live_sessions', liveSessionCount: 1 });
  });
});

describe('planEnvDelete — what has to die first', () => {
  it('given a live Sprite, should teardown_then_delete carrying the CAS instance', () => {
    const plan = planEnvDelete({ row: liveRow(), liveSessionCount: 0, force: false });
    expect(plan).toEqual({ action: 'teardown_then_delete', sandboxId: 'pgs-env-abc', expectedInstanceId: 'inst-1' });
  });

  it('given a live Sprite the platform reported no instance for, should still teardown with a null CAS', () => {
    const plan = planEnvDelete({ row: liveRow({ spriteInstanceId: null }), liveSessionCount: 0, force: false });
    expect(plan).toEqual({ action: 'teardown_then_delete', sandboxId: 'pgs-env-abc', expectedInstanceId: null });
  });

  it('given a never-provisioned env, should delete_only', () => {
    const plan = planEnvDelete({ row: makeRow(), liveSessionCount: 0, force: false });
    expect(plan).toEqual({ action: 'delete_only' });
  });

  it('given an ALREADY torn-down env, should delete_only — the pointer survives a teardown and must not re-kill', () => {
    // Teardown stamps `spriteTornDownAt` and deliberately LEAVES `sandboxId`
    // in place (a reclaim needs that pointer), so a name-only test would send
    // every stopped env back through a kill of a VM that is already gone.
    const plan = planEnvDelete({
      row: liveRow({ spriteTornDownAt: NOW }),
      liveSessionCount: 0,
      force: false,
    });
    expect(plan).toEqual({ action: 'delete_only' });
  });

  it('given a teardown REQUESTED but never confirmed, should still teardown — intent is not confirmation', () => {
    const plan = planEnvDelete({
      row: liveRow({ spriteTornDownAt: null }),
      liveSessionCount: 0,
      force: false,
    });
    expect(plan.action).toBe('teardown_then_delete');
  });
});
