import { describe, it, expect } from 'vitest';
import {
  ensureAgentSessionSandbox,
  intentForProbeOutcome,
  type AgentSessionSpriteDeps,
  type AgentSessionSpriteRow,
} from '../agent-session-sprite';
import { deriveAgentSessionSpriteKey } from '../../../agent-sessions/session-sprite-key';
import type { AgentSessionRecord } from '../agent-sessions-store';
import {
  AGENT_PAGE_ID,
  NOW,
  OWNER_ID,
  SECRET,
  SESSION_ID,
  TENANT_ID,
  makeAgentSessionStore,
  makeSessionRecord,
  makeSpriteHost,
  type FakeAgentSessionStore,
  type FakeSpriteHost,
} from './fakes';

const actor = { userId: OWNER_ID, tenantId: TENANT_ID };
const SESSION_KEY = deriveAgentSessionSpriteKey({ tenantId: TENANT_ID, sessionId: SESSION_ID, secret: SECRET });

function toSpriteRow(record: AgentSessionRecord): AgentSessionSpriteRow {
  return { ...record, sessionId: record.conversationId };
}

function makeDeps(
  fakes: { store: FakeAgentSessionStore; host: FakeSpriteHost },
  over: Partial<AgentSessionSpriteDeps> = {},
): AgentSessionSpriteDeps {
  return {
    store: fakes.store.store,
    host: fakes.host.host,
    substrate: { kind: 'sprite' },
    options: {},
    secret: SECRET,
    authorize: async () => ({ ok: true }),
    resolveDriveId: async () => 'drive-1',
    checkFullEgressEnablement: async () => ({ ok: true }),
    checkConcurrency: async () => ({ allowed: true }),
    now: () => NOW,
    ...over,
  };
}

describe('ensureAgentSessionSandbox — first provision', () => {
  it('given an unprovisioned session, should provision under its derived key and record the identity', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: false });
    expect(host.calls.provision[0].name).toBe(SESSION_KEY);
    const row = store.rows.get(SESSION_ID)!;
    expect(row.sandboxId).toBe(SESSION_KEY);
    expect(row.sessionKey).toBe(SESSION_KEY);
    expect(row.spriteInstanceId).toBe(`inst-${SESSION_KEY}`);
  });

  it('should start the sandbox EMPTY — no clone of any kind is attempted', async () => {
    // The three scope clone arms are deleted: git is an agent capability, run
    // inside the session with its own tools, not a provisioning step. The proof
    // available at this seam is that provisioning touches the host exactly once
    // and never execs into the VM.
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });
    expect(host.calls.provision).toHaveLength(1);
    expect(host.calls.attach).toHaveLength(0);
    expect(host.calls.kill).toHaveLength(0);
  });

  it('given a global-assistant session (no agent page), should authorize without a drive and still provision', async () => {
    const record = makeSessionRecord({ agentPageId: null });
    const store = makeAgentSessionStore([record]);
    const host = makeSpriteHost();
    const seen: Array<string | undefined> = [];
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(record),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host },
        {
          resolveDriveId: async () => {
            throw new Error('must not resolve a drive for a session with no agent page');
          },
          authorize: async (input) => {
            seen.push(input.driveId);
            return { ok: true };
          },
        },
      ),
    });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([undefined]);
  });

  it('should hand the stored egress token back to the host and persist the one it confirms', async () => {
    // The lockdown proof round-trip: a warm resume can skip the redundant push
    // only if the token that proved THIS VM's policy comes back to the host.
    const record = makeSessionRecord({ egressPolicyToken: 'tok-old' });
    const store = makeAgentSessionStore([record]);
    const host = makeSpriteHost({ egressTokenFor: () => 'tok-new' });
    await ensureAgentSessionSandbox({
      row: toSpriteRow(record),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(host.calls.provision[0].appliedEgressToken).toBe('tok-old');
    expect(store.rows.get(SESSION_ID)!.egressPolicyToken).toBe('tok-new');
  });

  it('should apply the verdict stamps — a provisioned session is active and not ended', async () => {
    const record = makeSessionRecord({ endedAt: NOW, spriteTornDownAt: NOW, teardownRequestedAt: NOW });
    const store = makeAgentSessionStore([record]);
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(record),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host: makeSpriteHost() }),
    });

    expect(result.ok).toBe(true);
    const row = store.rows.get(SESSION_ID)!;
    expect(row.endedAt).toBeNull();
    expect(row.spriteTornDownAt).toBeNull();
    expect(row.teardownRequestedAt).toBeNull();
    expect(row.lastActiveAt).toEqual(NOW);
    // A new VM is a new, empty disk: the old measurement describes a filesystem
    // that no longer exists.
    expect(row.storageMeasuredBytes).toBeNull();
    expect(row.storageMeasuredAt).toBeNull();
  });

  it('given a torn-down session, should RE-provision under the SAME key (same identity, fresh filesystem)', async () => {
    const record = makeSessionRecord({
      sessionKey: SESSION_KEY,
      sandboxId: SESSION_KEY,
      spriteInstanceId: 'inst-dead',
      spriteTornDownAt: NOW,
      endedAt: NOW,
    });
    const store = makeAgentSessionStore([record]);
    const host = makeSpriteHost();
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(record),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: false });
    expect(host.calls.provision[0].name).toBe(SESSION_KEY);
    // A torn-down row is not probed — its Sprite is known dead — so the CAS runs
    // against the pointer it still carries.
    expect(host.calls.attach).toHaveLength(0);
    expect(store.rows.get(SESSION_ID)!.spriteTornDownAt).toBeNull();
  });

  it('should measure storage while the fresh Sprite is awake, without awaiting it', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const seen: Array<{ sessionId: string; agentPageId: string | null }> = [];
    await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host: makeSpriteHost() },
        {
          measureSessionStorage: async ({ sessionId, agentPageId }) => {
            seen.push({ sessionId, agentPageId });
          },
        },
      ),
    });
    await Promise.resolve();
    expect(seen).toEqual([{ sessionId: SESSION_ID, agentPageId: AGENT_PAGE_ID }]);
  });

  it('given a measurement seam that rejects, should still report a successful provision', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host: makeSpriteHost() },
        { measureSessionStorage: async () => { throw new Error('measure exploded'); } },
      ),
    });
    await Promise.resolve();
    expect(result.ok).toBe(true);
  });
});

describe('ensureAgentSessionSandbox — concurrent provisioners', () => {
  it('given two concurrent provisioners, should converge on ONE instance and kill nothing', async () => {
    // `provision` is name-keyed, so both callers hold the SAME physical VM. The
    // CAS loser must recognize the winner recorded OUR instance and resume
    // against it — killing "ours" would destroy the winner's live VM.
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    const deps = makeDeps({ store, host });
    const row = toSpriteRow(makeSessionRecord());

    const [first, second] = await Promise.all([
      ensureAgentSessionSandbox({ row, intent: 'ensure', actor, deps }),
      ensureAgentSessionSandbox({ row, intent: 'ensure', actor, deps }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(first.sandboxId).toBe(SESSION_KEY);
    expect(second.sandboxId).toBe(SESSION_KEY);
    // Exactly one of them minted it; the other converged onto the same VM.
    expect([first.resumed, second.resumed].sort()).toEqual([false, true]);
    expect(host.calls.kill).toHaveLength(0);
    expect(store.rows.size).toBe(1);
    expect(store.rows.get(SESSION_ID)!.spriteInstanceId).toBe(`inst-${SESSION_KEY}`);
  });

  it('given a CAS loss whose winner holds a DIFFERENT instance, should kill the unreferenced VM it holds', async () => {
    // Not the shared-VM race: the row records someone else's generation, so ours
    // is genuinely unreferenced and would bill forever if left alive.
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost({ nextInstanceId: (_name, attempt) => `inst-${attempt}` });
    const deps = makeDeps({ store, host });
    const row = toSpriteRow(makeSessionRecord());

    const [first, second] = await Promise.all([
      ensureAgentSessionSandbox({ row, intent: 'ensure', actor, deps }),
      ensureAgentSessionSandbox({ row, intent: 'ensure', actor, deps }),
    ]);

    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    const loser = outcomes.find((r) => !r.ok);
    expect(loser).toEqual({ ok: false, reason: 'race_lost' });
    expect(host.calls.kill).toHaveLength(1);
  });

  it('given a cleanup kill that cannot be confirmed, should RESCUE the pointer into the reclaim outbox', async () => {
    // The row still carries a NULL/other pointer, so no trigger and no row-based
    // cross-check could ever discover this VM — the outbox is its only reclaim
    // path.
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost({
      nextInstanceId: (_name, attempt) => `inst-${attempt}`,
      killError: new Error('control plane down'),
    });
    const deps = makeDeps({ store, host });
    const row = toSpriteRow(makeSessionRecord());

    await Promise.all([
      ensureAgentSessionSandbox({ row, intent: 'ensure', actor, deps }),
      ensureAgentSessionSandbox({ row, intent: 'ensure', actor, deps }),
    ]);

    expect(store.reclaims.size).toBe(1);
    expect([...store.reclaims.keys()]).toEqual([SESSION_KEY]);
  });

  it('given a persist that THROWS while a winner recorded our exact instance, should resume rather than kill', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    const winner = { ...makeSessionRecord(), sandboxId: SESSION_KEY, spriteInstanceId: `inst-${SESSION_KEY}` };
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host },
        {
          store: {
            ...store.store,
            updateSpriteIdentity: async () => {
              throw new Error('transient db error');
            },
            reloadSpritePointer: async () => ({
              sandboxId: winner.sandboxId,
              spriteInstanceId: winner.spriteInstanceId,
            }),
          },
        },
      ),
    });

    expect(result).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: true });
    expect(host.calls.kill).toHaveLength(0);
  });

  it('given a persist that THROWS with no winner, should report persist_failed and not leave the VM alive', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host },
        {
          store: {
            ...store.store,
            updateSpriteIdentity: async () => {
              throw new Error('transient db error');
            },
          },
        },
      ),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('persist_failed');
    expect(result.detail).toContain('transient db error');
    expect(host.calls.kill).toHaveLength(1);
    expect(host.live.has(SESSION_KEY)).toBe(false);
    expect(store.rows.get(SESSION_ID)!.sandboxId).toBeNull();
  });
});

describe('ensureAgentSessionSandbox — resumed Sprite identity (ABA)', () => {
  const provisioned = makeSessionRecord({
    sessionKey: SESSION_KEY,
    sandboxId: SESSION_KEY,
    spriteInstanceId: 'inst-old',
    egressPolicyToken: 'tok-old',
  });

  it('given a live Sprite whose instance MATCHES the row, should resume without rewriting the identity', async () => {
    const store = makeAgentSessionStore([makeSessionRecord({ ...provisioned, spriteInstanceId: 'inst-live' })]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-live' } } });
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord({ ...provisioned, spriteInstanceId: 'inst-live' })),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: true });
    expect(host.calls.provision).toHaveLength(0);
    expect(store.calls.updateSpriteIdentity).toBe(0);
    expect(store.rows.get(SESSION_ID)!.lastActiveAt).toEqual(NOW);
  });

  it('given a resumed Sprite whose instance CHANGED, should ADOPT the live one and re-apply the egress proof', async () => {
    // A replacement provisioned under the same deterministic name while the row
    // still records the predecessor. Without adoption every later teardown passes
    // the stale instance, the kill politely misses, and the live replacement
    // bills forever with nothing pointing at it.
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({
      seed: { [SESSION_KEY]: { instanceId: 'inst-new', egressPolicyToken: 'tok-new' } },
    });
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: true });
    const row = store.rows.get(SESSION_ID)!;
    expect(row.spriteInstanceId).toBe('inst-new');
    expect(row.egressPolicyToken).toBe('tok-new');
    expect(host.calls.provision).toHaveLength(0);
    expect(host.calls.kill).toHaveLength(0);
  });

  it('given an adoption on a row with NO session key, should DENY rather than resume on a stale identity', async () => {
    const keyless = makeSessionRecord({ sessionKey: null, sandboxId: SESSION_KEY, spriteInstanceId: 'inst-old' });
    const store = makeAgentSessionStore([keyless]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-new' } } });
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(keyless),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: false, reason: 'denied', denial: 'missing_session_key', detail: undefined });
    expect(store.rows.get(SESSION_ID)!.spriteInstanceId).toBe('inst-old');
  });

  it('given an adoption CAS that loses to a concurrent adopt of a different instance, should kill the VM it holds', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-new' } } });
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host },
        {
          store: {
            ...store.store,
            updateSpriteIdentity: async () => false,
            reloadSpritePointer: async () => ({ sandboxId: 'sbx-other', spriteInstanceId: 'inst-someone-else' }),
          },
        },
      ),
    });

    expect(result).toEqual({ ok: false, reason: 'race_lost' });
    expect(host.calls.kill).toEqual([{ sandboxId: SESSION_KEY, expectedInstanceId: 'inst-new' }]);
  });

  it('given an adoption whose Sprite vanishes between the probe and the adopt, should report it rather than record a dead identity', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-new' } } });
    let attaches = 0;
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host },
        {
          host: {
            ...host.host,
            attach: async (args) => {
              attaches += 1;
              // The probe sees it; by the time we go back for the adopt it is gone.
              return attaches === 1 ? host.host.attach(args) : null;
            },
          },
        },
      ),
    });

    expect(result).toEqual({ ok: false, reason: 'provision_failed', detail: 'adopted_sprite_vanished' });
    expect(store.rows.get(SESSION_ID)!.spriteInstanceId).toBe('inst-old');
  });

  it('given an adoption whose CAS THROWS while a winner recorded our exact instance, should resume rather than kill', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-new' } } });
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host },
        {
          store: {
            ...store.store,
            updateSpriteIdentity: async () => {
              throw new Error('transient db error');
            },
            reloadSpritePointer: async () => ({ sandboxId: SESSION_KEY, spriteInstanceId: 'inst-new' }),
          },
        },
      ),
    });

    expect(result).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: true });
    expect(host.calls.kill).toHaveLength(0);
  });

  it('given an adoption whose CAS THROWS with no winner, should report persist_failed and not leave the VM unreferenced', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-new' } } });
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host },
        {
          store: {
            ...store.store,
            updateSpriteIdentity: async () => {
              throw new Error('transient db error');
            },
          },
        },
      ),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('persist_failed');
    expect(host.calls.kill).toEqual([{ sandboxId: SESSION_KEY, expectedInstanceId: 'inst-new' }]);
  });

  it('given a row with no session key that still needs one derived, should derive the same deterministic name', async () => {
    // A row that lost its key is not a second source of truth: the derivation is
    // deterministic, so it reproduces exactly what the row would have carried.
    const keyless = makeSessionRecord({ sessionKey: null });
    const store = makeAgentSessionStore([keyless]);
    const host = makeSpriteHost();
    await ensureAgentSessionSandbox({
      row: toSpriteRow(keyless),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(host.calls.provision[0].name).toBe(SESSION_KEY);
    expect(store.rows.get(SESSION_ID)!.sessionKey).toBe(SESSION_KEY);
  });

  it('given a control plane that will not answer the probe, should leave the pointer alone and resume', async () => {
    // We learned NOTHING: reprovisioning blind could duplicate a live VM on a
    // transient blip, so the pointer stands and a retry settles it.
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ attachError: new Error('control plane down') });
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: true });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given a VANISHED Sprite on ensure, should reprovision under the same key', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost(); // nothing live under the name
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: false });
    expect(host.calls.provision[0].name).toBe(SESSION_KEY);
    expect(store.rows.get(SESSION_ID)!.spriteInstanceId).toBe(`inst-${SESSION_KEY}`);
  });
});

describe('ensureAgentSessionSandbox — attach', () => {
  const provisioned = makeSessionRecord({
    sessionKey: SESSION_KEY,
    sandboxId: SESSION_KEY,
    spriteInstanceId: 'inst-live',
  });

  it('given a live session, should resume without provisioning', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-live' } } });
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'attach',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: true });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given an unprovisioned session, should DENY — attach never mints a VM', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'attach',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: false, reason: 'denied', denial: 'sandbox_not_provisioned', detail: undefined });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given a torn-down session, should DENY rather than silently resurrect or share a Sprite', async () => {
    const ended = makeSessionRecord({ ...provisioned, spriteTornDownAt: NOW, endedAt: NOW });
    const store = makeAgentSessionStore([ended]);
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(ended),
      intent: 'attach',
      actor,
      deps: makeDeps({ store, host: makeSpriteHost() }),
    });

    expect(result).toEqual({ ok: false, reason: 'denied', denial: 'session_torn_down', detail: undefined });
  });

  it('given a VANISHED Sprite on attach, should report it rather than hand back a dead pointer', async () => {
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost();
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'attach',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: false, reason: 'provision_failed', detail: 'sandbox_vanished' });
    expect(host.calls.provision).toHaveLength(0);
  });
});

describe('ensureAgentSessionSandbox — refusals', () => {
  it('given an actor who may not run code, should deny BEFORE provisioning anything', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }, { authorize: async () => ({ ok: false, reason: 'app_admin_required' }) }),
    });

    expect(result).toEqual({
      ok: false,
      reason: 'denied',
      denial: 'not_authorized',
      detail: 'app_admin_required',
    });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given an actor who lost the right to a WARM session, should deny rather than hand it back', async () => {
    const provisioned = makeSessionRecord({ sessionKey: SESSION_KEY, sandboxId: SESSION_KEY, spriteInstanceId: 'i' });
    const store = makeAgentSessionStore([provisioned]);
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host: makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'i' } } }) },
        { authorize: async () => ({ ok: false, reason: 'insufficient_role' }) },
      ),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.denial).toBe('not_authorized');
  });

  it('given full egress not enabled, should refuse to mint a VM', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host },
        { checkFullEgressEnablement: async () => ({ ok: false, reason: 'containment_unverified' }) },
      ),
    });

    expect(result).toEqual({ ok: false, reason: 'egress_denied', detail: 'containment_unverified' });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given a resume, should NOT re-run the egress gate — the lockdown is already proven for that VM', async () => {
    const provisioned = makeSessionRecord({ sessionKey: SESSION_KEY, sandboxId: SESSION_KEY, spriteInstanceId: 'i' });
    const store = makeAgentSessionStore([provisioned]);
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host: makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'i' } } }) },
        {
          checkConcurrency: async () => ({ allowed: true }),
          checkFullEgressEnablement: async () => {
            throw new Error('must not gate a resume');
          },
        },
      ),
    });

    expect(result.ok).toBe(true);
  });

  it('given a provision that throws, should classify it and leave the row unprovisioned', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost({ provisionError: new Error('no capacity') });
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: false, reason: 'provision_failed', detail: 'no capacity' });
    expect(store.rows.get(SESSION_ID)!.sandboxId).toBeNull();
  });

  it('given an unresolvable drive, should let authorization fail closed', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host },
        {
          resolveDriveId: async () => null,
          authorize: async (input) => (input.driveId ? { ok: true } : { ok: false, reason: 'no_drive_access' }),
        },
      ),
    });

    expect(result.ok).toBe(false);
    expect(host.calls.provision).toHaveLength(0);
  });
});

describe('intentForProbeOutcome', () => {
  it('given a vanished Sprite on ensure, should ask for a reprovision', () => {
    expect(intentForProbeOutcome('ensure', { kind: 'vanished' })).toBe('reprovision');
  });

  it('given a vanished Sprite on ATTACH, should keep attach — it may never mint a VM', () => {
    expect(intentForProbeOutcome('attach', { kind: 'vanished' })).toBe('attach');
  });

  it('given an unanswerable probe, should change nothing', () => {
    expect(intentForProbeOutcome('ensure', { kind: 'unknown' })).toBe('ensure');
  });

  it('given a live or unprobed Sprite, should change nothing', () => {
    expect(intentForProbeOutcome('ensure', { kind: 'unprobed' })).toBe('ensure');
    expect(
      intentForProbeOutcome('ensure', { kind: 'live', instance: { sandboxId: 's', spriteInstanceId: 'i' } }),
    ).toBe('ensure');
  });

  it('given an explicit reprovision, should stay a reprovision whatever the probe said', () => {
    expect(intentForProbeOutcome('reprovision', { kind: 'vanished' })).toBe('reprovision');
    expect(intentForProbeOutcome('reprovision', { kind: 'unprobed' })).toBe('reprovision');
  });
});

/**
 * The per-owner live-session ceiling is a dep of THIS module rather than of any
 * one caller, because every first touch funnels through here — the web routes,
 * the sandbox and session tools, and the realtime shell bridge, which calls this
 * module directly rather than through the web app's wrapper. A gate at a single
 * call site would leave the socket path as a way around the tier limit.
 */
describe('ensureAgentSessionSandbox — concurrency ceiling', () => {
  it('given the owner is at their ceiling, should refuse BEFORE minting a VM', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();

    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor: { userId: OWNER_ID, tenantId: TENANT_ID },
      deps: makeDeps(
        { store, host },
        { checkConcurrency: async () => ({ allowed: false, reason: 'live agent-session limit reached' }) },
      ),
    });

    expect(result).toMatchObject({ ok: false, reason: 'denied', denial: 'not_authorized' });
    // The point of gating before the mint: no VM exists to leak or bill.
    expect(host.calls.provision).toHaveLength(0);
    expect(store.rows.get(SESSION_ID)?.sandboxId).toBeNull();
  });

  it('given an ENDED session re-provisioning, should NOT claim the exemption — its allocation is not counted', async () => {
    // The exemption must track `countLive` exactly (sandboxId set AND not torn
    // down). Teardown leaves `sandboxId` in place, so testing that column alone
    // would exempt every ended session: end N, re-provision all N, and the
    // owner holds N live sandboxes past their ceiling.
    const ended = makeSessionRecord({
      sandboxId: 'sbx-dead',
      sessionKey: SESSION_KEY,
      spriteInstanceId: 'i-dead',
      spriteTornDownAt: NOW,
    });
    const store = makeAgentSessionStore([ended]);
    const host = makeSpriteHost();
    const seen: Array<{ ownerId: string; alreadyProvisioned: boolean }> = [];

    await ensureAgentSessionSandbox({
      row: toSpriteRow(ended),
      intent: 'ensure',
      actor: { userId: OWNER_ID, tenantId: TENANT_ID },
      deps: makeDeps({ store, host }, {
        checkConcurrency: async (input) => { seen.push(input); return { allowed: true }; },
      }),
    });

    expect(seen).toEqual([{ ownerId: OWNER_ID, alreadyProvisioned: false }]);
  });

  it('given a re-provision of a row that already holds a sandbox, should tell the ceiling it is already provisioned', async () => {
    const provisioned = makeSessionRecord({ sandboxId: 'sbx-live', sessionKey: SESSION_KEY, spriteInstanceId: 'i' });
    const store = makeAgentSessionStore([provisioned]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'i' } } });
    const seen: Array<{ ownerId: string; alreadyProvisioned: boolean }> = [];

    await ensureAgentSessionSandbox({
      row: toSpriteRow(provisioned),
      intent: 'ensure',
      actor: { userId: OWNER_ID, tenantId: TENANT_ID },
      deps: makeDeps({ store, host }, {
        checkConcurrency: async (input) => { seen.push(input); return { allowed: true }; },
      }),
    });

    // A row whose Sprite vanished re-provisions under the SAME key, so it does
    // reach the create arm — and this is precisely the case the exemption
    // exists for: the ceiling is told the row already holds an allocation, so
    // an owner sitting at their limit can still recover their own session
    // rather than being locked out of a Sprite they are already paying for.
    expect(seen).toEqual([{ ownerId: OWNER_ID, alreadyProvisioned: true }]);
  });
});
