import { describe, it, expect } from 'vitest';
import {
  planAgentSessionLifecycle,
  planSessionReopen,
  type AgentSessionLifecycleRow,
  type AgentSessionIntent,
} from '../plan-workspace-lifecycle';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const LONG_AGO = new Date('2020-01-01T00:00:00.000Z');

function row(overrides: Partial<AgentSessionLifecycleRow> = {}): AgentSessionLifecycleRow {
  return {
    workspaceId: 'conv-1',
    spriteKey: 'pgs-ses-abc',
    sandboxId: 'pgs-ses-abc',
    spriteInstanceId: 'inst-1',
    egressPolicyToken: 'tok-1',
    teardownRequestedAt: null,
    spriteTornDownAt: null,
    endedAt: null,
    lastActiveAt: NOW,
    ...overrides,
  };
}

/** A row that has never acquired a sandbox (created lazily by the first chat turn). */
const unprovisioned = row({ sandboxId: null, spriteInstanceId: null, spriteKey: null, egressPolicyToken: null });

/** A row whose Sprite was killed by an explicit "end session" — retained, re-provisionable under the same key. */
const tornDown = row({
  sandboxId: null,
  spriteInstanceId: null,
  teardownRequestedAt: NOW,
  spriteTornDownAt: NOW,
  endedAt: NOW,
});

describe('planAgentSessionLifecycle — ensure (lazy first touch)', () => {
  it('given no row, should create', () => {
    const plan = planAgentSessionLifecycle({ row: null, intent: 'ensure', canRun: true, now: NOW });
    expect(plan.action).toBe('create');
    expect(plan.stamps.lastActiveAt).toEqual(NOW);
  });

  it('given no row and a create verdict, should have no previous sandbox to CAS against', () => {
    const plan = planAgentSessionLifecycle({ row: null, intent: 'ensure', canRun: true, now: NOW });
    if (plan.action !== 'create') throw new Error('expected create');
    expect(plan.previousSandboxId).toBeNull();
  });

  it('given an unprovisioned row, should create (the sandbox is acquired lazily, not at row insert)', () => {
    const plan = planAgentSessionLifecycle({ row: unprovisioned, intent: 'ensure', canRun: true, now: NOW });
    expect(plan.action).toBe('create');
  });

  it('given a torn-down row, should create and REVIVE the row (same key, fresh Sprite)', () => {
    const plan = planAgentSessionLifecycle({ row: tornDown, intent: 'ensure', canRun: true, now: NOW });
    expect(plan.action).toBe('create');
    expect(plan.stamps).toMatchObject({
      lastActiveAt: NOW,
      endedAt: null,
      teardownRequestedAt: null,
      spriteTornDownAt: null,
    });
  });

  it('given a provisioned row, should resume under the SAME key', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'ensure', canRun: true, now: NOW });
    if (plan.action !== 'resume') throw new Error('expected resume');
    expect(plan.sandboxId).toBe('pgs-ses-abc');
    expect(plan.spriteInstanceId).toBe('inst-1');
    expect(plan.stamps.lastActiveAt).toEqual(NOW);
  });

  it('given a resume, should void any stale teardown INTENT (this row now points at a live Sprite)', () => {
    const plan = planAgentSessionLifecycle({
      row: row({ teardownRequestedAt: LONG_AGO }),
      intent: 'ensure',
      canRun: true,
      now: NOW,
    });
    expect(plan.action).toBe('resume');
    expect(plan.stamps.teardownRequestedAt).toBeNull();
  });

  it('given canRun false, should deny BEFORE handing back any warm session', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'ensure', canRun: false, now: NOW });
    if (plan.action !== 'deny') throw new Error('expected deny');
    expect(plan.reason).toBe('not_authorized');
  });

  it('given canRun false and no row, should deny rather than create a billable VM', () => {
    const plan = planAgentSessionLifecycle({ row: null, intent: 'ensure', canRun: false, now: NOW });
    expect(plan.action).toBe('deny');
  });
});

describe('planAgentSessionLifecycle — attach (read-only resolve; never mints a VM)', () => {
  it('given a provisioned row, should resume', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'attach', canRun: true, now: NOW });
    expect(plan.action).toBe('resume');
  });

  it('given no row, should deny (a PTY connect addresses an EXISTING session)', () => {
    const plan = planAgentSessionLifecycle({ row: null, intent: 'attach', canRun: true, now: NOW });
    if (plan.action !== 'deny') throw new Error('expected deny');
    expect(plan.reason).toBe('session_not_found');
  });

  it('given a torn-down row, should deny rather than share or resurrect a Sprite', () => {
    const plan = planAgentSessionLifecycle({ row: tornDown, intent: 'attach', canRun: true, now: NOW });
    if (plan.action !== 'deny') throw new Error('expected deny');
    expect(plan.reason).toBe('session_torn_down');
  });

  it('given an unprovisioned row, should deny — attach never provisions (ensure does)', () => {
    const plan = planAgentSessionLifecycle({ row: unprovisioned, intent: 'attach', canRun: true, now: NOW });
    if (plan.action !== 'deny') throw new Error('expected deny');
    expect(plan.reason).toBe('sandbox_not_provisioned');
  });

  it('given canRun false, should deny (attach re-authorizes every time)', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'attach', canRun: false, now: NOW });
    if (plan.action !== 'deny') throw new Error('expected deny');
    expect(plan.reason).toBe('not_authorized');
  });
});

describe('planAgentSessionLifecycle — live-instance reconciliation (ABA)', () => {
  const live = { sandboxId: 'pgs-ses-abc', spriteInstanceId: 'inst-2' };

  it.each<AgentSessionIntent>(['ensure', 'attach'])(
    'given %s and a live instance MATCHING the row, should plainly resume',
    (intent) => {
      const plan = planAgentSessionLifecycle({
        row: row(),
        intent,
        canRun: true,
        now: NOW,
        liveInstance: { sandboxId: 'pgs-ses-abc', spriteInstanceId: 'inst-1' },
      });
      expect(plan.action).toBe('resume');
    },
  );

  it.each<AgentSessionIntent>(['ensure', 'attach'])(
    'given %s and a live instance that MOVED, should adopt — never a blind kill',
    (intent) => {
      const plan = planAgentSessionLifecycle({ row: row(), intent, canRun: true, now: NOW, liveInstance: live });
      if (plan.action !== 'adopt') throw new Error('expected adopt');
      expect(plan.sandboxId).toBe('pgs-ses-abc');
      expect(plan.spriteInstanceId).toBe('inst-2');
      expect(plan.previousSandboxId).toBe('pgs-ses-abc');
      expect(plan.previousSpriteInstanceId).toBe('inst-1');
    },
  );

  it('given an adopt, should drop the stored storage measurement (a new VM has a fresh disk)', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'ensure', canRun: true, now: NOW, liveInstance: live });
    expect(plan.stamps).toMatchObject({
      lastActiveAt: NOW,
      teardownRequestedAt: null,
      storageMeasuredBytes: null,
      storageMeasuredAt: null,
    });
  });

  it('given a live instance under a DIFFERENT sandbox name, should adopt both name and instance', () => {
    const plan = planAgentSessionLifecycle({
      row: row(),
      intent: 'ensure',
      canRun: true,
      now: NOW,
      liveInstance: { sandboxId: 'pgs-ses-other', spriteInstanceId: 'inst-2' },
    });
    if (plan.action !== 'adopt') throw new Error('expected adopt');
    expect(plan.sandboxId).toBe('pgs-ses-other');
    expect(plan.previousSandboxId).toBe('pgs-ses-abc');
  });

  it('given a row with a NULL instance and a live one, should adopt (the row learns which VM it holds)', () => {
    const plan = planAgentSessionLifecycle({
      row: row({ spriteInstanceId: null }),
      intent: 'ensure',
      canRun: true,
      now: NOW,
      liveInstance: live,
    });
    expect(plan.action).toBe('adopt');
  });

  it('given both instances null, should resume (nothing to reconcile; name-only ABA risk accepted)', () => {
    const plan = planAgentSessionLifecycle({
      row: row({ spriteInstanceId: null }),
      intent: 'ensure',
      canRun: true,
      now: NOW,
      liveInstance: { sandboxId: 'pgs-ses-abc', spriteInstanceId: null },
    });
    expect(plan.action).toBe('resume');
  });

  it('given a live instance the platform could not identify, should adopt the unidentified handle', () => {
    const plan = planAgentSessionLifecycle({
      row: row(),
      intent: 'ensure',
      canRun: true,
      now: NOW,
      liveInstance: { sandboxId: 'pgs-ses-abc', spriteInstanceId: null },
    });
    if (plan.action !== 'adopt') throw new Error('expected adopt');
    expect(plan.spriteInstanceId).toBeNull();
  });

  it('given a moved instance on a row with NO session key, should deny (an identity we cannot CAS)', () => {
    const plan = planAgentSessionLifecycle({
      row: row({ spriteKey: null }),
      intent: 'ensure',
      canRun: true,
      now: NOW,
      liveInstance: live,
    });
    if (plan.action !== 'deny') throw new Error('expected deny');
    expect(plan.reason).toBe('missing_session_key');
  });

  it('given a live instance but no row sandbox, should ignore it and create (nothing to reconcile against)', () => {
    const plan = planAgentSessionLifecycle({
      row: unprovisioned,
      intent: 'ensure',
      canRun: true,
      now: NOW,
      liveInstance: live,
    });
    expect(plan.action).toBe('create');
  });

  it('given canRun false, should deny before reconciling anything', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'ensure', canRun: false, now: NOW, liveInstance: live });
    expect(plan.action).toBe('deny');
  });
});

describe('planAgentSessionLifecycle — end (instance-guarded teardown, row retained)', () => {
  it('given a provisioned row, should tear down guarded by the recorded INSTANCE', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'end', canRun: true, now: NOW });
    if (plan.action !== 'teardown') throw new Error('expected teardown');
    expect(plan.sandboxId).toBe('pgs-ses-abc');
    expect(plan.expectedInstanceId).toBe('inst-1');
  });

  it('given a teardown, should stamp teardownRequestedAt, spriteTornDownAt and endedAt', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'end', canRun: true, now: NOW });
    expect(plan.stamps).toMatchObject({
      teardownRequestedAt: NOW,
      spriteTornDownAt: NOW,
      endedAt: NOW,
    });
  });

  it('should never delete the row — teardown is a stamp, not a removal', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'end', canRun: true, now: NOW });
    expect(Object.keys(plan)).not.toContain('delete');
  });

  it('given canRun false, should STILL tear down (cleanup is never gated on authorization)', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'end', canRun: false, now: NOW });
    expect(plan.action).toBe('teardown');
  });

  it('given no row, should noop', () => {
    const plan = planAgentSessionLifecycle({ row: null, intent: 'end', canRun: true, now: NOW });
    if (plan.action !== 'noop') throw new Error('expected noop');
    expect(plan.reason).toBe('no_session');
    expect(plan.stamps).toEqual({});
  });

  it('given an unprovisioned row, should noop but still mark the session ended', () => {
    const plan = planAgentSessionLifecycle({ row: unprovisioned, intent: 'end', canRun: true, now: NOW });
    if (plan.action !== 'noop') throw new Error('expected noop');
    expect(plan.reason).toBe('no_sandbox');
    expect(plan.stamps.endedAt).toEqual(NOW);
  });

  it('given an already torn-down row, should noop with nothing left to stamp', () => {
    const plan = planAgentSessionLifecycle({ row: tornDown, intent: 'end', canRun: true, now: NOW });
    if (plan.action !== 'noop') throw new Error('expected noop');
    expect(plan.reason).toBe('already_ended');
    expect(plan.stamps).toEqual({});
  });

  it('given an ended row whose Sprite pointer survived (unconfirmed kill), should RETRY the teardown', () => {
    const plan = planAgentSessionLifecycle({
      row: row({ endedAt: NOW, teardownRequestedAt: NOW, spriteTornDownAt: null }),
      intent: 'end',
      canRun: true,
      now: NOW,
    });
    expect(plan.action).toBe('teardown');
  });

  it('given a NORMALLY-ended row (provisioned, CONFIRMED kill — the common shape), should noop rather than re-teardown', () => {
    // review #2261/4: teardown never clears `sandboxId` (the row outlives its
    // Sprite on purpose), so `tornDown`/`unprovisioned` above — both
    // `sandboxId: null` — are the UNCOMMON shape. The common one, a session
    // that was provisioned and then normally ended, still carries its
    // `sandboxId`; that used to fall through to `teardown` on every re-end.
    const endedProvisioned = row({ teardownRequestedAt: NOW, spriteTornDownAt: NOW, endedAt: NOW });
    const plan = planAgentSessionLifecycle({ row: endedProvisioned, intent: 'end', canRun: true, now: NOW });
    if (plan.action !== 'noop') throw new Error('expected noop');
    expect(plan.reason).toBe('already_ended');
    expect(plan.stamps).toEqual({});
  });

  it('a REOPENED row (endedAt withdrawn by planSessionReopen, kill still confirmed) is re-endable: the fresh end-intent is stamped, nothing is re-killed', () => {
    const reopened = row({ teardownRequestedAt: NOW, spriteTornDownAt: NOW, endedAt: null });
    const plan = planAgentSessionLifecycle({ row: reopened, intent: 'end', canRun: true, now: NOW });
    if (plan.action !== 'noop') throw new Error('expected noop');
    expect(plan.stamps.endedAt).toEqual(NOW);
  });
});

describe('planSessionReopen', () => {
  it('withdraws ONLY the end-intent — the confirmed-kill stamp survives, so provisioning still fresh-creates and attach still refuses', () => {
    expect(planSessionReopen()).toEqual({ endedAt: null });
  });
});

describe('planAgentSessionLifecycle — reprovision (heal a row whose Sprite is unusable)', () => {
  it('given a provisioned row, should create while CASing against the old pointer', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'reprovision', canRun: true, now: NOW });
    if (plan.action !== 'create') throw new Error('expected create');
    expect(plan.previousSandboxId).toBe('pgs-ses-abc');
  });

  it('given an unprovisioned row, should create', () => {
    const plan = planAgentSessionLifecycle({ row: unprovisioned, intent: 'reprovision', canRun: true, now: NOW });
    expect(plan.action).toBe('create');
  });

  it('given a torn-down row, should create and revive it', () => {
    const plan = planAgentSessionLifecycle({ row: tornDown, intent: 'reprovision', canRun: true, now: NOW });
    expect(plan.action).toBe('create');
    expect(plan.stamps.endedAt).toBeNull();
  });

  it('given a live instance, should still create — reprovision is a deliberate replacement, not a resume', () => {
    const plan = planAgentSessionLifecycle({
      row: row(),
      intent: 'reprovision',
      canRun: true,
      now: NOW,
      liveInstance: { sandboxId: 'pgs-ses-abc', spriteInstanceId: 'inst-2' },
    });
    expect(plan.action).toBe('create');
  });

  it('given no row, should deny (there is nothing to reprovision)', () => {
    const plan = planAgentSessionLifecycle({ row: null, intent: 'reprovision', canRun: true, now: NOW });
    if (plan.action !== 'deny') throw new Error('expected deny');
    expect(plan.reason).toBe('session_not_found');
  });

  it('given canRun false, should deny', () => {
    const plan = planAgentSessionLifecycle({ row: row(), intent: 'reprovision', canRun: false, now: NOW });
    expect(plan.action).toBe('deny');
  });
});

describe('planAgentSessionLifecycle — hibernation model', () => {
  it.each<AgentSessionIntent>(['ensure', 'attach'])(
    'given %s on a row idle for years, should resume — idleness alone NEVER destroys',
    (intent) => {
      const plan = planAgentSessionLifecycle({
        row: row({ lastActiveAt: LONG_AGO }),
        intent,
        canRun: true,
        now: NOW,
      });
      expect(plan.action).toBe('resume');
    },
  );

  it('should never emit a teardown for any intent other than end', () => {
    const intents: AgentSessionIntent[] = ['ensure', 'attach', 'reprovision'];
    const rows = [null, row(), unprovisioned, tornDown, row({ lastActiveAt: LONG_AGO })];
    for (const intent of intents) {
      for (const candidate of rows) {
        const plan = planAgentSessionLifecycle({ row: candidate, intent, canRun: true, now: NOW });
        expect(plan.action).not.toBe('teardown');
      }
    }
  });

  it('given an intent outside the four, should throw rather than silently pick a verdict', () => {
    expect(() =>
      planAgentSessionLifecycle({
        row: row(),
        intent: 'destroy' as AgentSessionIntent,
        canRun: true,
        now: NOW,
      }),
    ).toThrow(/unhandled agent-session intent/);
  });

  it('every verdict should carry a stamps bag so the runtime writes rows uniformly', () => {
    const intents: AgentSessionIntent[] = ['ensure', 'attach', 'end', 'reprovision'];
    for (const intent of intents) {
      for (const candidate of [null, row(), unprovisioned, tornDown]) {
        for (const canRun of [true, false]) {
          const plan = planAgentSessionLifecycle({ row: candidate, intent, canRun, now: NOW });
          expect(plan.stamps).toBeDefined();
        }
      }
    }
  });
});
