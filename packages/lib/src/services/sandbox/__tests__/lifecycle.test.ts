import { describe, it, expect } from 'vitest';
import { planSandboxLifecycle } from '../lifecycle';
import type { CanRunCodeResult } from '../can-run-code';

const allowed: CanRunCodeResult = { ok: true };
const denied: CanRunCodeResult = { ok: false, reason: 'insufficient_role' };

const now = new Date('2026-06-01T12:00:00.000Z');
const fresh = { sandboxId: 'sbx-1', lastActiveAt: new Date('2026-06-01T11:59:00.000Z') };
// Idle for an hour — well past the old 15-min destroy timer, but a hibernated VM
// that should now RESUME (wake on demand), not be destroyed.
const stale = { sandboxId: 'sbx-1', lastActiveAt: new Date('2026-06-01T11:00:00.000Z') };
// Abandoned beyond the 24h hard-expiry ceiling — the only idle teardown.
const abandoned = { sandboxId: 'sbx-1', lastActiveAt: new Date('2026-05-30T12:00:00.000Z') };

describe('planSandboxLifecycle', () => {
  it('given an authorized actor with no existing session, should plan to create', () => {
    const plan = planSandboxLifecycle({ authorization: allowed, existingSession: null, now });
    expect(plan).toEqual({ action: 'create' });
  });

  it('given an authorized actor with a fresh existing session (within the warm window), should resume WITHOUT a relock', () => {
    const plan = planSandboxLifecycle({ authorization: allowed, existingSession: fresh, now });
    expect(plan).toEqual({ action: 'resume', sandboxId: 'sbx-1', relock: false });
  });

  it('given an unauthorized actor with no session, should deny with the authorization reason', () => {
    const plan = planSandboxLifecycle({ authorization: denied, existingSession: null, now });
    expect(plan).toEqual({ action: 'deny', reason: 'insufficient_role' });
  });

  it('given an unauthorized actor with an existing warm session, should deny — never hand back the warm sandbox', () => {
    const plan = planSandboxLifecycle({ authorization: denied, existingSession: fresh, now });
    expect(plan).toEqual({ action: 'deny', reason: 'insufficient_role' });
  });

  it('given an idle (hibernated) session within the hard-expiry window but past the warm window, should resume WITH a relock — not destroy the sleeping VM', () => {
    // `stale` is idle ~1h: past the 5-min warm window, so the egress policy is
    // refreshed on hand-back, but well under the 24h hard-expiry, so it resumes.
    const plan = planSandboxLifecycle({ authorization: allowed, existingSession: stale, now });
    expect(plan).toEqual({ action: 'resume', sandboxId: 'sbx-1', relock: true });
  });

  it('given a session abandoned past the hard-expiry ceiling, should plan to tear it down and reclaim', () => {
    const plan = planSandboxLifecycle({ authorization: allowed, existingSession: abandoned, now });
    expect(plan).toEqual({ action: 'teardown', sandboxId: 'sbx-1', reason: 'idle' });
  });

  it('given a custom warm window, should relock a resume at/past it and not within it', () => {
    const warmWindowMs = 30 * 60 * 1000; // 30 min
    // `fresh` (1 min idle) is within the window → no relock.
    expect(
      planSandboxLifecycle({ authorization: allowed, existingSession: fresh, now, warmWindowMs }),
    ).toEqual({ action: 'resume', sandboxId: 'sbx-1', relock: false });
    // `stale` (1 h idle) is past the window → relock.
    expect(
      planSandboxLifecycle({ authorization: allowed, existingSession: stale, now, warmWindowMs }),
    ).toEqual({ action: 'resume', sandboxId: 'sbx-1', relock: true });
  });

  it('given a custom hard-expiry, should resume just under it and tear down at or past it', () => {
    const hardExpiryMs = 5 * 60 * 1000;
    expect(
      planSandboxLifecycle({ authorization: allowed, existingSession: fresh, now, hardExpiryMs }),
    ).toEqual({ action: 'resume', sandboxId: 'sbx-1', relock: false });
    expect(
      planSandboxLifecycle({ authorization: allowed, existingSession: stale, now, hardExpiryMs }),
    ).toEqual({ action: 'teardown', sandboxId: 'sbx-1', reason: 'idle' });
  });

  it('given a session-end intent with an existing session, should plan to tear it down', () => {
    const plan = planSandboxLifecycle({
      authorization: allowed,
      existingSession: fresh,
      now,
      intent: 'end',
    });
    expect(plan).toEqual({ action: 'teardown', sandboxId: 'sbx-1', reason: 'session_end' });
  });

  it('given a session-end intent with no existing session, should plan no-op', () => {
    const plan = planSandboxLifecycle({ authorization: allowed, existingSession: null, now, intent: 'end' });
    expect(plan).toEqual({ action: 'noop' });
  });

  it('given a session-end intent, should tear down even an unauthorized actor is irrelevant (cleanup always allowed)', () => {
    // Teardown on end must not depend on re-authz — an expiring session is cleaned up
    // regardless, so a revoked actor can never leave an orphaned warm sandbox behind.
    const plan = planSandboxLifecycle({
      authorization: denied,
      existingSession: fresh,
      now,
      intent: 'end',
    });
    expect(plan).toEqual({ action: 'teardown', sandboxId: 'sbx-1', reason: 'session_end' });
  });
});
