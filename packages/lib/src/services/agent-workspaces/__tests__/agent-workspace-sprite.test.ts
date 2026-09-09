import { describe, it, expect } from 'vitest';
import {
  ensureAgentSessionSandbox,
  intentForProbeOutcome,
  type AgentSessionSpriteDeps,
  type AgentSessionSpriteRow,
} from '../agent-workspace-sprite';
import { deriveAgentSessionSpriteKey } from '../../../agent-workspaces/workspace-sprite-key';
import type { AgentSessionRecord } from '../agent-workspaces-store';
import {
  DRIVE_ID,
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
const SESSION_KEY = deriveAgentSessionSpriteKey({ tenantId: TENANT_ID, workspaceId: SESSION_ID, secret: SECRET });

function toSpriteRow(record: AgentSessionRecord): AgentSessionSpriteRow {
  return { ...record, workspaceId: record.id };
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
    checkFullEgressEnablement: async () => ({ ok: true }),
    checkConcurrency: async () => ({ allowed: true }),
    // The default row is ephemeral (`envId: null`), so this seam is never
    // reached; a test that binds a session to an env overrides it. Throwing
    // rather than returning a canned success is deliberate — an env-bound row
    // that fell through to the SESSION arm would be the bug, and a silent
    // success would hide it.
    ensureEnvSandbox: async () => {
      throw new Error('ensureEnvSandbox called for an ephemeral session');
    },
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
    expect(row.spriteKey).toBe(SESSION_KEY);
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

  it('given a global-assistant session (no drive), should authorize without a drive and still provision', async () => {
    const record = makeSessionRecord({ driveId: null });
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
      spriteKey: SESSION_KEY,
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
    const seen: Array<{ workspaceId: string }> = [];
    await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host: makeSpriteHost() },
        {
          measureSessionStorage: async ({ workspaceId }) => {
            seen.push({ workspaceId });
          },
        },
      ),
    });
    await Promise.resolve();
    expect(seen).toEqual([{ workspaceId: SESSION_ID }]);
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
    spriteKey: SESSION_KEY,
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
    const keyless = makeSessionRecord({ spriteKey: null, sandboxId: SESSION_KEY, spriteInstanceId: 'inst-old' });
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
    const keyless = makeSessionRecord({ spriteKey: null });
    const store = makeAgentSessionStore([keyless]);
    const host = makeSpriteHost();
    await ensureAgentSessionSandbox({
      row: toSpriteRow(keyless),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(host.calls.provision[0].name).toBe(SESSION_KEY);
    expect(store.rows.get(SESSION_ID)!.spriteKey).toBe(SESSION_KEY);
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

describe('ensureAgentSessionSandbox — resume vs a concurrent end (review #2261/1 mirror)', () => {
  it('given a concurrent end that ended the row between the read and the activity stamp, should NOT erase its teardown intent', async () => {
    // The caller read this row (not ended) before calling ensure. Concurrently,
    // endAgentSession ran to completion — teardown never clears `sandboxId`, so
    // an identity CAS alone cannot catch this; only a state CAS on `endedAt`
    // can. Without it, the resume arm's unconditional
    // `{ endedAt: null, teardownRequestedAt: null }` stamp would silently erase
    // the concurrent end's teardown intent.
    const live = makeSessionRecord({ spriteKey: SESSION_KEY, sandboxId: SESSION_KEY, spriteInstanceId: 'inst-live' });
    const store = makeAgentSessionStore([live]);
    const host = makeSpriteHost({ seed: { [SESSION_KEY]: { instanceId: 'inst-live' } } });

    store.rows.set(SESSION_ID, { ...live, teardownRequestedAt: NOW, spriteTornDownAt: NOW, endedAt: NOW });

    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(live),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: true });
    const row = store.rows.get(SESSION_ID)!;
    expect(row.endedAt).toEqual(NOW);
    expect(row.teardownRequestedAt).toEqual(NOW);
    expect(row.spriteTornDownAt).toEqual(NOW);
  });
});

describe('ensureAgentSessionSandbox — attach', () => {
  const provisioned = makeSessionRecord({
    spriteKey: SESSION_KEY,
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
      deps: makeDeps({ store, host }, { authorize: async () => ({ ok: false, reason: 'tier_ineligible' }) }),
    });

    expect(result).toEqual({
      ok: false,
      reason: 'denied',
      denial: 'not_authorized',
      detail: 'tier_ineligible',
    });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given an actor who lost the right to a WARM session, should deny rather than hand it back', async () => {
    const provisioned = makeSessionRecord({ spriteKey: SESSION_KEY, sandboxId: SESSION_KEY, spriteInstanceId: 'i' });
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

  it('given the quota check THROWS, should mint nothing — the ceiling fails closed', async () => {
    // A transient DB failure in `countLive` must not become an open door. There
    // is no try/catch here today and the throw propagates, which is correct —
    // but "correct by absence" is exactly what a well-meaning later `catch`
    // defaulting to `{ allowed: true }` would quietly undo, and a ceiling that
    // fails open under load is a ceiling that fails open exactly when it
    // matters. Pinned on the observable effect: no VM.
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();

    await expect(
      ensureAgentSessionSandbox({
        row: toSpriteRow(makeSessionRecord()),
        intent: 'ensure',
        actor,
        deps: makeDeps(
          { store, host },
          {
            checkConcurrency: async () => {
              throw new Error('connection terminated');
            },
          },
        ),
      }),
    ).rejects.toThrow('connection terminated');

    expect(host.calls.provision).toHaveLength(0);
  });

  it('given the egress gate THROWS, should mint nothing — containment fails closed too', async () => {
    // Same reasoning for the other gate that stands between a request and a
    // live VM with network access.
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();

    await expect(
      ensureAgentSessionSandbox({
        row: toSpriteRow(makeSessionRecord()),
        intent: 'ensure',
        actor,
        deps: makeDeps(
          { store, host },
          {
            checkFullEgressEnablement: async () => {
              throw new Error('flag service unreachable');
            },
          },
        ),
      }),
    ).rejects.toThrow('flag service unreachable');

    expect(host.calls.provision).toHaveLength(0);
  });

  it('given a resume, should NOT re-run the egress gate — the lockdown is already proven for that VM', async () => {
    const provisioned = makeSessionRecord({ spriteKey: SESSION_KEY, sandboxId: SESSION_KEY, spriteInstanceId: 'i' });
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

  it('given authorization refuses, should provision NOTHING — no VM exists to leak or bill', async () => {
    // The old variant of this test made resolveDriveId fail; that dep died
    // with the un-conflation (the drive is a fact of the ROW now, nothing to
    // resolve). The invariant it protected survives: a refused authorize must
    // reach the host zero times.
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host },
        {
          authorize: async () => ({ ok: false, reason: 'no_drive_access' }),
        },
      ),
    });

    expect(result.ok).toBe(false);
    expect(host.calls.provision).toHaveLength(0);
  });

  it('should authorize against the ROW driveId — the session decides its drive, never the caller', async () => {
    const seen: Array<string | undefined> = [];
    const store = makeAgentSessionStore([makeSessionRecord()]);
    await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord({ driveId: 'drive-from-row' })),
      intent: 'ensure',
      actor,
      deps: makeDeps(
        { store, host: makeSpriteHost() },
        {
          authorize: async (input) => {
            seen.push(input.driveId);
            return { ok: true };
          },
        },
      ),
    });
    expect(seen).toEqual(['drive-from-row']);
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

    // `session_limit_reached`, NOT `not_authorized`: the caller has every right
    // to this session and has simply run out of allowance. The routes map the
    // two differently (429 + a real message vs 403 + an authz-denial audit row).
    expect(result).toMatchObject({ ok: false, reason: 'denied', denial: 'session_limit_reached' });
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
      spriteKey: SESSION_KEY,
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
    const provisioned = makeSessionRecord({ sandboxId: 'sbx-live', spriteKey: SESSION_KEY, spriteInstanceId: 'i' });
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

/**
 * Sessions INSIDE an environment — the routing half.
 *
 * The property under test is that an env-bound session NEVER takes the session
 * arm. Not "usually", and not "when the call site remembers": the row is
 * CHECK-forbidden from holding Sprite pointers, so a session-arm provision
 * would mint a real, billed VM under the session keyspace and then fail its own
 * identity CAS — an orphan, from a code path that looked like it worked.
 */
describe('ensureAgentSessionSandbox — inside an environment', () => {
  const ENV_ID = 'env-1';
  const ENV_SANDBOX = 'pgs-env-abc';
  const envRow = makeSessionRecord({ envId: ENV_ID });

  it('should provision the ENV and hand back the ENV\'s sandbox — never the session\'s own', async () => {
    const store = makeAgentSessionStore([envRow]);
    const host = makeSpriteHost();
    const seen: Array<{ envId: string; intent: string }> = [];

    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(envRow),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }, {
        ensureEnvSandbox: async (input) => {
          seen.push(input);
          return { ok: true, sandboxId: ENV_SANDBOX, resumed: false };
        },
      }),
    });

    expect(result).toEqual({ ok: true, sandboxId: ENV_SANDBOX, resumed: false });
    expect(seen).toEqual([{ envId: ENV_ID, intent: 'ensure' }]);
    // Nothing was minted under the SESSION's key, and the session row still
    // holds no pointer — which is what the database's CHECK requires of it.
    expect(host.calls.provision).toEqual([]);
    expect(store.rows.get(envRow.id)!.sandboxId).toBeNull();
    expect(store.rows.get(envRow.id)!.spriteKey).toBeNull();
  });

  it('given TWO sessions in ONE env, should resolve the SAME sandbox — sharing is the env, not a threaded handle', async () => {
    const second = makeSessionRecord({ id: 'ses-2', envId: ENV_ID });
    const store = makeAgentSessionStore([envRow, second]);
    const host = makeSpriteHost();
    const ensureEnvSandbox = async () => ({ ok: true as const, sandboxId: ENV_SANDBOX, resumed: true });

    const [a, b] = await Promise.all([
      ensureAgentSessionSandbox({
        row: toSpriteRow(envRow),
        intent: 'ensure',
        actor,
        deps: makeDeps({ store, host }, { ensureEnvSandbox }),
      }),
      ensureAgentSessionSandbox({
        row: toSpriteRow(second),
        intent: 'ensure',
        actor,
        deps: makeDeps({ store, host }, { ensureEnvSandbox }),
      }),
    ]);

    expect(a).toEqual(b);
    expect(a.ok && a.sandboxId).toBe(ENV_SANDBOX);
  });

  it('given the session-level REPROVISION intent, should degrade to ATTACH — one session\'s retry must never wipe a shared disk', async () => {
    // Replacing an env's Sprite is `rebuildDriveEnv` and nothing else. Forwarding
    // the intent would let a wedged shell or a retrying client delete a team's
    // environment out from under everyone working in it.
    const store = makeAgentSessionStore([envRow]);
    const host = makeSpriteHost();
    const seen: string[] = [];

    await ensureAgentSessionSandbox({
      row: toSpriteRow(envRow),
      intent: 'reprovision',
      actor,
      deps: makeDeps({ store, host }, {
        ensureEnvSandbox: async ({ intent }) => {
          seen.push(intent);
          return { ok: true, sandboxId: ENV_SANDBOX, resumed: true };
        },
      }),
    });

    expect(seen).toEqual(['attach']);
  });

  it('should forward ATTACH unchanged, so an unprovisioned env is DENIED rather than lazily minted on a reconnect', async () => {
    const store = makeAgentSessionStore([envRow]);
    const host = makeSpriteHost();
    const seen: string[] = [];

    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(envRow),
      intent: 'attach',
      actor,
      deps: makeDeps({ store, host }, {
        ensureEnvSandbox: async ({ intent }) => {
          seen.push(intent);
          return { ok: false, reason: 'denied', denial: 'sandbox_not_provisioned' };
        },
      }),
    });

    expect(seen).toEqual(['attach']);
    expect(result).toEqual({ ok: false, reason: 'denied', denial: 'sandbox_not_provisioned' });
  });

  it('should never reach the per-owner live-SESSION ceiling — the env is the billed unit', async () => {
    const store = makeAgentSessionStore([envRow]);
    const host = makeSpriteHost();
    let ceilingChecks = 0;

    await ensureAgentSessionSandbox({
      row: toSpriteRow(envRow),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }, {
        ensureEnvSandbox: async () => ({ ok: true, sandboxId: ENV_SANDBOX, resumed: false }),
        checkConcurrency: async () => {
          ceilingChecks += 1;
          return { allowed: true };
        },
      }),
    });

    expect(ceilingChecks).toBe(0);
  });

  it('given an ENDED env session, should REVIVE its row — a usable session must not stay invisible', async () => {
    // The env arm hands back a sandbox without touching the session's row, so
    // without an explicit revive an ended session would work while still
    // reading as ended: absent from every listing, reported `'ended'` by the
    // API, and refused the filesystem — with its tools functioning throughout.
    const ended = makeSessionRecord({ envId: ENV_ID, endedAt: NOW, teardownRequestedAt: NOW });
    const store = makeAgentSessionStore([ended]);
    const host = makeSpriteHost();

    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(ended),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }, {
        ensureEnvSandbox: async () => ({ ok: true, sandboxId: ENV_SANDBOX, resumed: true }),
      }),
    });

    expect(result.ok).toBe(true);
    const revived = store.rows.get(ended.id)!;
    expect(revived.endedAt).toBeNull();
    expect(revived.teardownRequestedAt).toBeNull();
    expect(revived.lastActiveAt).toEqual(NOW);
    // ...and STILL no Sprite columns, which the database forbids on this row.
    expect(revived.sandboxId).toBeNull();
    expect(revived.spriteKey).toBeNull();
    expect(revived.spriteInstanceId).toBeNull();
  });

  it('should stamp lastActiveAt on an ordinary env ensure, so the listing can order it', async () => {
    const store = makeAgentSessionStore([envRow]);
    const host = makeSpriteHost();

    await ensureAgentSessionSandbox({
      row: toSpriteRow(envRow),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }, {
        ensureEnvSandbox: async () => ({ ok: true, sandboxId: ENV_SANDBOX, resumed: true }),
      }),
    });

    expect(store.rows.get(envRow.id)!.lastActiveAt).toEqual(NOW);
  });

  it('given a concurrent END on a LIVE session, should not silently erase it', async () => {
    // Same hazard the session arm's resume guards (review #2261/1): these stamps
    // were computed for a session that was live when we read it, so an `end`
    // that landed while the env provisioned is the user's most recent word and
    // must stand. The sandbox handed back is unaffected — only the freshness
    // touch is skipped.
    // Its OWN row object: the fake store holds what it is given by reference,
    // so mutating a shared fixture here would leak an `endedAt` into every
    // later test in this block.
    const racing = makeSessionRecord({ envId: ENV_ID });
    const store = makeAgentSessionStore([racing]);
    const host = makeSpriteHost();

    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(racing), // read while live...
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }, {
        ensureEnvSandbox: async () => {
          // ...and ended while the env was being provisioned.
          store.rows.get(racing.id)!.endedAt = NOW;
          return { ok: true, sandboxId: ENV_SANDBOX, resumed: true };
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(store.rows.get(racing.id)!.endedAt).toEqual(NOW);
  });

  it('given the env provision FAILED, should leave the session row alone', async () => {
    // Nothing was provisioned, so nothing is live — stamping a row as active
    // because a failed call happened to touch it is how a dead session ends up
    // sorting to the top of a listing.
    const ended = makeSessionRecord({ envId: ENV_ID, endedAt: NOW });
    const store = makeAgentSessionStore([ended]);
    const host = makeSpriteHost();

    await ensureAgentSessionSandbox({
      row: toSpriteRow(ended),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }, {
        ensureEnvSandbox: async () => ({ ok: false, reason: 'provision_failed', detail: 'env_not_found' }),
      }),
    });

    expect(store.rows.get(ended.id)!.endedAt).toEqual(NOW);
    expect(store.rows.get(ended.id)!.lastActiveAt).toBeNull();
  });

  it('given ATTACH on an ENDED env session, should DENY rather than resurrect it', async () => {
    // The shared planner refuses `attach` on an ended row, but on this path it
    // only ever sees the ENV's row, which knows nothing about the session
    // ending. Without the explicit refusal an attach against a live environment
    // would succeed and clear `endedAt` — putting a session the user ended back
    // in the sidebar holding the empty tree `endSession` already destroyed.
    const ended = makeSessionRecord({ envId: ENV_ID, endedAt: NOW });
    const store = makeAgentSessionStore([ended]);
    const host = makeSpriteHost();
    let envCalls = 0;

    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(ended),
      intent: 'attach',
      actor,
      deps: makeDeps({ store, host }, {
        ensureEnvSandbox: async () => {
          envCalls += 1;
          return { ok: true, sandboxId: ENV_SANDBOX, resumed: true };
        },
      }),
    });

    expect(result).toEqual({ ok: false, reason: 'denied', denial: 'session_torn_down' });
    expect(envCalls).toBe(0);
    expect(store.rows.get(ended.id)!.endedAt).toEqual(NOW);
  });

  it('given ATTACH on a LIVE env session, should resolve without stamping — a read-only resolve writes nothing', async () => {
    const store = makeAgentSessionStore([envRow]);
    const host = makeSpriteHost();

    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(envRow),
      intent: 'attach',
      actor,
      deps: makeDeps({ store, host }, {
        ensureEnvSandbox: async () => ({ ok: true, sandboxId: ENV_SANDBOX, resumed: true }),
      }),
    });

    expect(result).toEqual({ ok: true, sandboxId: ENV_SANDBOX, resumed: true });
    // The planner's attach arm writes no revival stamps for an ordinary
    // session either; this keeps the two kinds saying the same thing.
    expect(store.rows.get(envRow.id)!.lastActiveAt).toBeNull();
  });

  it('given an ORDINARY session, should never consult the env seam', async () => {
    const store = makeAgentSessionStore([makeSessionRecord()]);
    const host = makeSpriteHost();
    let envCalls = 0;

    const result = await ensureAgentSessionSandbox({
      row: toSpriteRow(makeSessionRecord()),
      intent: 'ensure',
      actor,
      deps: makeDeps({ store, host }, {
        ensureEnvSandbox: async () => {
          envCalls += 1;
          return { ok: true, sandboxId: ENV_SANDBOX, resumed: false };
        },
      }),
    });

    expect(envCalls).toBe(0);
    expect(result).toEqual({ ok: true, sandboxId: SESSION_KEY, resumed: false });
  });
});
