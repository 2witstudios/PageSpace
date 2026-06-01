import { describe, it, expect } from 'vitest';
import { planSandboxLifecycle } from '../lifecycle';
import type { CanRunCodeResult } from '../can-run-code';

const allowed: CanRunCodeResult = { ok: true };
const denied: CanRunCodeResult = { ok: false, reason: 'insufficient_role' };

const now = new Date('2026-06-01T12:00:00.000Z');
const fresh = { sandboxId: 'sbx-1', lastActiveAt: new Date('2026-06-01T11:59:00.000Z') };
const stale = { sandboxId: 'sbx-1', lastActiveAt: new Date('2026-06-01T11:00:00.000Z') };

describe('planSandboxLifecycle', () => {
  it('given an authorized actor with no existing session, should plan to create', () => {
    const plan = planSandboxLifecycle({ authorization: allowed, existingSession: null, now });
    expect(plan).toEqual({ action: 'create' });
  });

  it('given an authorized actor with a fresh existing session, should plan to resume that sandbox', () => {
    const plan = planSandboxLifecycle({ authorization: allowed, existingSession: fresh, now });
    expect(plan).toEqual({ action: 'resume', sandboxId: 'sbx-1' });
  });

  it('given an unauthorized actor with no session, should deny with the authorization reason', () => {
    const plan = planSandboxLifecycle({ authorization: denied, existingSession: null, now });
    expect(plan).toEqual({ action: 'deny', reason: 'insufficient_role' });
  });

  it('given an unauthorized actor with an existing warm session, should deny — never hand back the warm sandbox', () => {
    const plan = planSandboxLifecycle({ authorization: denied, existingSession: fresh, now });
    expect(plan).toEqual({ action: 'deny', reason: 'insufficient_role' });
  });

  it('given an authorized actor with an idle-expired session, should plan to tear it down', () => {
    const plan = planSandboxLifecycle({
      authorization: allowed,
      existingSession: stale,
      now,
      idleTimeoutMs: 5 * 60 * 1000,
    });
    expect(plan).toEqual({ action: 'teardown', sandboxId: 'sbx-1', reason: 'idle' });
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
