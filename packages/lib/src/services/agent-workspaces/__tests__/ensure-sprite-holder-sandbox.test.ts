/**
 * The provisioning core, driven by a holder that is NOT a session.
 *
 * Every other suite in this directory reaches the core through
 * `ensureAgentSessionSandbox`, which proves the session path still works but
 * cannot prove the thing the refactor actually claims: that the core carries no
 * session assumptions. If the only caller is the session wrapper, "holder-neutral"
 * is an assertion about code nobody has run any other way.
 *
 * So this suite stands up an ENVIRONMENT holder — a bare `SpriteHolderStore` over a row
 * map, keys derived with `deriveDriveEnvSpriteKey`, no `AgentSessionStore`, no
 * `ownerId`, no actor, no session secret — and drives `ensureSpriteHolderSandbox`
 * directly. It is also the standing regression test for Phase 3's central
 * invariant: two sessions opening in one environment must land on ONE VM, which is the
 * CAS's job and nothing else's.
 */

import { describe, it, expect } from 'vitest';
import { assert } from '../../sandbox/__tests__/riteway';
import { ensureSpriteHolderSandbox, type SpriteHolderProvisionDeps, type SpriteHolderStore } from '../agent-workspace-sprite';
import type { SpriteHolderLifecycleRow } from '../../../agent-workspaces/plan-workspace-lifecycle';
import { stampColumns } from '../agent-workspaces-store';
import { deriveDriveEnvSpriteKey } from '../../../drive-envs/env-sprite-key';
import { makeSpriteHost, NOW, SECRET, TENANT_ID, type FakeSpriteHost } from './fakes';

const ENV_ID = 'env-1';
const ENV_KEY = deriveDriveEnvSpriteKey({ tenantId: TENANT_ID, envId: ENV_ID, secret: SECRET });

/**
 * The provisioner's row slice, plus the billing watermark the store writes
 * alongside the identity. `storageLastBilledAt` is not part of
 * `SpriteHolderLifecycleRow` — the provisioner never reads it — but the store
 * DOES write it, so the fake has to carry it to model that write.
 */
type FakeHolderRow = SpriteHolderLifecycleRow & { storageLastBilledAt?: Date };

function makeEnvRow(over: Partial<FakeHolderRow> = {}): FakeHolderRow {
  return {
    holderId: ENV_ID,
    spriteKey: null,
    sandboxId: null,
    spriteInstanceId: null,
    egressPolicyToken: null,
    teardownRequestedAt: null,
    spriteTornDownAt: null,
    endedAt: null,
    lastActiveAt: null,
    ...over,
  };
}

interface FakeEnvStore {
  store: SpriteHolderStore;
  rows: Map<string, FakeHolderRow>;
  reclaims: Map<string, string | null>;
}

/**
 * An environment-shaped holder store with the REAL identity CAS — the same discipline the
 * session fake keeps, for the same reason: a fake that accepts writes the
 * production CAS would refuse makes every concurrency test agree with a bug.
 */
function makeEnvStore(seed: SpriteHolderLifecycleRow[] = [makeEnvRow()]): FakeEnvStore {
  const rows = new Map<string, FakeHolderRow>(seed.map((row) => [row.holderId, row]));
  const reclaims = new Map<string, string | null>();

  const store: SpriteHolderStore = {
    async updateSpriteIdentity(input) {
      const row = rows.get(input.holderId);
      if (!row) return false;
      // CAS on the CURRENT pointer — null for a first provision, the
      // vanished/replaced name for a re-provision.
      if ((row.sandboxId ?? null) !== (input.previousSandboxId ?? null)) return false;
      rows.set(input.holderId, {
        ...row,
        spriteKey: input.spriteKey,
        sandboxId: input.sandboxId,
        spriteInstanceId: input.spriteInstanceId,
        egressPolicyToken: input.egressPolicyToken,
        // The MONOTONIC billing-watermark reset, mirroring the real stores'
        // `GREATEST(column, <now>)`. Modelled here rather than assigned because
        // `now` is captured before the provider IO and can be older than a
        // watermark a reconcile tick already advanced — a fake that assigned
        // would let that guard be deleted with this whole suite still green.
        storageLastBilledAt:
          row.storageLastBilledAt !== undefined && row.storageLastBilledAt > input.now
            ? row.storageLastBilledAt
            : input.now,
        // Through the REAL translator, not a spread of `input.stamps`. Its
        // whole job is that an ABSENT key leaves a column alone while an
        // explicit `null` clears it, and a spread collapses the two the moment
        // a caller builds a stamp bag with an explicit `undefined`. A fake that
        // collapses it agrees with a bug the production store would reject.
        ...stampColumns(input.stamps),
      });
      return true;
    },
    async applyStamps({ holderId, stamps, cas }) {
      const row = rows.get(holderId);
      if (!row) return true;
      // Same three behaviors the session fake mirrors from the real store: an
      // empty stamp bag is a legitimate no-op, and each CAS compares by VALUE —
      // `endedAt` by timestamp rather than `Date` identity, which reference
      // equality would get wrong for every non-null guard.
      const columns = stampColumns(stamps);
      if (Object.keys(columns).length === 0) return true;
      if (cas?.sandboxId !== undefined && (row.sandboxId ?? null) !== (cas.sandboxId ?? null)) return false;
      if (cas?.endedAt !== undefined && (row.endedAt?.getTime() ?? null) !== (cas.endedAt?.getTime() ?? null)) {
        return false;
      }
      rows.set(holderId, { ...row, ...columns });
      return true;
    },
    async reloadSpritePointer(holderId) {
      const row = rows.get(holderId);
      if (!row) return null;
      return { sandboxId: row.sandboxId, spriteInstanceId: row.spriteInstanceId };
    },
    async enqueueReclaim({ sandboxId, spriteInstanceId }) {
      // Idempotent on the sandboxId, chasing the newest instance — mirrors the
      // AFTER-DELETE trigger's own insert, exactly as the session fake does.
      reclaims.set(sandboxId, spriteInstanceId ?? reclaims.get(sandboxId) ?? null);
    },
  };

  return { store, rows, reclaims };
}

function makeEnvDeps(
  fakes: { store: FakeEnvStore; host: FakeSpriteHost },
  over: Partial<SpriteHolderProvisionDeps> = {},
): SpriteHolderProvisionDeps {
  return {
    store: fakes.store.store,
    host: fakes.host.host,
    substrate: { kind: 'sprite' },
    options: {},
    deriveSpriteKey: (holderId) => deriveDriveEnvSpriteKey({ tenantId: TENANT_ID, envId: holderId, secret: SECRET }),
    authorize: async () => ({ ok: true }),
    checkFullEgressEnablement: async () => ({ ok: true }),
    checkQuota: async () => ({ allowed: true }),
    now: () => NOW,
    ...over,
  };
}

describe('ensureSpriteHolderSandbox — a non-session holder', () => {
  it('should provision under the HOLDER-supplied key, never a session key', async () => {
    // The key-derivation seam is the whole reason environment names cannot collide with
    // reclaim-pending session names. If the core reached for the session
    // derivation, this name would carry `pgs-ses-`.
    const store = makeEnvStore();
    const host = makeSpriteHost();
    const result = await ensureSpriteHolderSandbox({
      row: makeEnvRow(),
      intent: 'ensure',
      deps: makeEnvDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: ENV_KEY, resumed: false });
    expect(host.calls.provision[0].name).toBe(ENV_KEY);
    expect(ENV_KEY.startsWith('pgs-env-')).toBe(true);
    expect(store.rows.get(ENV_ID)!.spriteKey).toBe(ENV_KEY);
  });

  it('given two concurrent first-ensures of ONE environment, should yield ONE VM (the Phase 3 shared-filesystem invariant)', async () => {
    // This is the case the provisioner's docblock exists for. Two sessions
    // opening in the same environment at the same moment must not mint two VMs: the
    // host is name-keyed so both hold the same physical Sprite, and the CAS
    // decides which one records it. The loser must resume onto the winner's VM,
    // not kill it — killing it would take down the filesystem both sessions are
    // about to share.
    const store = makeEnvStore();
    const host = makeSpriteHost();
    const deps = makeEnvDeps({ store, host });

    const [a, b] = await Promise.all([
      ensureSpriteHolderSandbox({ row: makeEnvRow(), intent: 'ensure', deps }),
      ensureSpriteHolderSandbox({ row: makeEnvRow(), intent: 'ensure', deps }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.ok && a.sandboxId).toBe(ENV_KEY);
    expect(b.ok && b.sandboxId).toBe(ENV_KEY);
    // The load-bearing assertion. "Both got the same sandboxId" is NOT evidence
    // of a working CAS — the host is name-keyed, so both callers hold one VM
    // whether or not the CAS refuses anyone. What only a working CAS produces is
    // exactly ONE writer: one caller records the identity (`resumed: false`) and
    // the other loses, reconciles, and resumes onto it (`resumed: true`). With
    // the CAS defeated, both report `resumed: false` and this fails.
    const resumedFlags = [a.ok && a.resumed, b.ok && b.resumed].sort();
    expect(resumedFlags).toEqual([false, true]);
    // One VM, still alive: the lost CAS resolved to a resume, not a teardown.
    expect(host.live.size).toBe(1);
    expect(host.calls.kill).toHaveLength(0);
    expect(store.reclaims.size).toBe(0);
  });

  it('given an already-provisioned environment, should RESUME its Sprite rather than mint another', async () => {
    const store = makeEnvStore([makeEnvRow({ spriteKey: ENV_KEY, sandboxId: ENV_KEY, spriteInstanceId: `inst-${ENV_KEY}` })]);
    const host = makeSpriteHost({ seed: { [ENV_KEY]: { instanceId: `inst-${ENV_KEY}` } } });

    const result = await ensureSpriteHolderSandbox({
      row: store.rows.get(ENV_ID)!,
      intent: 'ensure',
      deps: makeEnvDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: ENV_KEY, resumed: true });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given two DIFFERENT environments, should provision two distinct Sprites', async () => {
    const store = makeEnvStore([makeEnvRow({ holderId: 'env-a' }), makeEnvRow({ holderId: 'env-b' })]);
    const host = makeSpriteHost();
    const deps = makeEnvDeps({ store, host });

    const a = await ensureSpriteHolderSandbox({ row: makeEnvRow({ holderId: 'env-a' }), intent: 'ensure', deps });
    const b = await ensureSpriteHolderSandbox({ row: makeEnvRow({ holderId: 'env-b' }), intent: 'ensure', deps });

    expect(a.ok && b.ok && a.sandboxId).not.toBe(b.ok && b.sandboxId);
    expect(host.live.size).toBe(2);
  });

  it('given an unauthorized actor, should deny BEFORE touching the host', async () => {
    // The authorize seam is holder-neutral too: the core never learns who the
    // actor is, only whether the wrapper says yes.
    const store = makeEnvStore();
    const host = makeSpriteHost();
    const result = await ensureSpriteHolderSandbox({
      row: makeEnvRow(),
      intent: 'ensure',
      deps: makeEnvDeps({ store, host }, { authorize: async () => ({ ok: false, reason: 'no_env_access' }) }),
    });

    expect(result).toEqual({ ok: false, reason: 'denied', denial: 'not_authorized', detail: 'no_env_access' });
    expect(host.calls.provision).toHaveLength(0);
  });

  it("should surface the holder's OWN quota verdict — both halves, the core invents neither", async () => {
    // The core hardcodes no part of a quota refusal. It used to bake in
    // `denial: 'session_limit_reached'`, which would have labelled an ENVIRONMENT's
    // refusal a live-session ceiling — wrong on the wire and wrong in the
    // security audit. Both halves are the holder's to name, and this pins that:
    // a refusal reports back exactly what `checkQuota` said, nothing defaulted.
    const store = makeEnvStore();
    const host = makeSpriteHost();
    const deps = makeEnvDeps(
      { store, host },
      {
        checkQuota: async () => ({
          allowed: false,
          denial: 'not_authorized',
          reason: 'environment limit reached for this drive',
        }),
      },
    );

    const result = await ensureSpriteHolderSandbox({ row: makeEnvRow(), intent: 'ensure', deps });

    expect(result).toEqual({
      ok: false,
      reason: 'denied',
      // Deliberately NOT `session_limit_reached`: a value the core could only
      // have produced by passing the holder's own answer through.
      denial: 'not_authorized',
      detail: 'environment limit reached for this drive',
    });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given the egress gate refuses, should not provision', async () => {
    const store = makeEnvStore();
    const host = makeSpriteHost();
    const result = await ensureSpriteHolderSandbox({
      row: makeEnvRow(),
      intent: 'ensure',
      deps: makeEnvDeps(
        { store, host },
        { checkFullEgressEnablement: async () => ({ ok: false, reason: 'containment_unverified' }) },
      ),
    });

    expect(result).toEqual({ ok: false, reason: 'egress_denied', detail: 'containment_unverified' });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given attach on an environment that has never provisioned, should deny — attach never mints', async () => {
    const store = makeEnvStore();
    const host = makeSpriteHost();
    const result = await ensureSpriteHolderSandbox({
      row: makeEnvRow(),
      intent: 'attach',
      deps: makeEnvDeps({ store, host }),
    });

    expect(result).toEqual({ ok: false, reason: 'denied', denial: 'sandbox_not_provisioned' });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('should measure storage opportunistically, keyed by HOLDER id', async () => {
    const store = makeEnvStore();
    const host = makeSpriteHost();
    const measured: string[] = [];
    await ensureSpriteHolderSandbox({
      row: makeEnvRow(),
      intent: 'ensure',
      deps: makeEnvDeps(
        { store, host },
        {
          measureStorage: async ({ holderId }) => {
            measured.push(holderId);
          },
        },
      ),
    });

    expect(measured).toEqual([ENV_ID]);
  });

  it('does NOT measure on the ADOPT arm, even though that arm clears the measurement', async () => {
    // The wake rule wins over the coverage gap. A `du` is an exec, and an exec is
    // the only way to wake a hibernated Sprite — `adopt`'s evidence that the VM
    // exists is `probeRecordedSprite`'s control-plane `attach`, which says
    // nothing about whether it is RUNNING. Measuring here could resume a paused
    // machine and restart its runtime billing, which is worse than the 0 floor
    // this leaves behind: under-billing is the accepted direction in this meter,
    // waking a VM nobody asked to run is not.
    const provisionedEnv = makeEnvRow({ spriteKey: 'env-key', sandboxId: 'pgs-env-1', spriteInstanceId: 'inst-old' });
    const store = makeEnvStore([provisionedEnv]);
    const host = makeSpriteHost({ seed: { 'pgs-env-1': { instanceId: 'inst-new' } } });
    const measured: string[] = [];

    const result = await ensureSpriteHolderSandbox({
      row: provisionedEnv,
      intent: 'ensure',
      deps: makeEnvDeps(
        { store, host },
        {
          measureStorage: async ({ holderId }) => {
            measured.push(holderId);
          },
        },
      ),
    });

    assert({
      given: 'an env whose Sprite was replaced under the same name, so the plan is ADOPT',
      should: 'adopt the live instance but run NO `du` — its VM cannot be proven awake',
      actual: { result, measured, instance: store.rows.get(ENV_ID)?.spriteInstanceId },
      expected: {
        result: { ok: true, sandboxId: 'pgs-env-1', resumed: true },
        measured: [],
        instance: 'inst-new',
      },
    });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('should NOT measure on a plain RESUME either — the same disk, and the same wake rule', async () => {
    const provisionedEnv = makeEnvRow({ spriteKey: 'env-key', sandboxId: 'pgs-env-1', spriteInstanceId: 'inst-1' });
    const store = makeEnvStore([provisionedEnv]);
    const host = makeSpriteHost({ seed: { 'pgs-env-1': { instanceId: 'inst-1' } } });
    const measured: string[] = [];

    await ensureSpriteHolderSandbox({
      row: provisionedEnv,
      intent: 'ensure',
      deps: makeEnvDeps(
        { store, host },
        {
          measureStorage: async ({ holderId }) => {
            measured.push(holderId);
          },
        },
      ),
    });

    assert({
      given: 'an env reconnecting to the SAME Sprite instance',
      should: 'skip the measurement — resume clears nothing, so a `du` here would buy nothing and might wake it',
      actual: measured,
      expected: [],
    });
  });

  it('NEVER drags a holder\'s billing watermark backwards when it provisions', async () => {
    // The anti-double-bill guard, exercised through the fake store so it is
    // pinned in the unit run and not only in the DB-backed suite (which is
    // skippable locally). `ensureSpriteHolderSandbox` captures its `now` BEFORE
    // the provider IO, so a provision can land carrying a timestamp older than a
    // watermark a reconcile tick has already advanced — assigning it would
    // re-bill the span between them on the next tick.
    const alreadyBilledThrough = new Date(NOW.getTime() + 60_000);
    const row = makeEnvRow({ storageLastBilledAt: alreadyBilledThrough });
    const store = makeEnvStore([row]);
    const host = makeSpriteHost();

    await ensureSpriteHolderSandbox({ row, intent: 'ensure', deps: makeEnvDeps({ store, host }) });

    assert({
      given: 'a provision landing with a timestamp older than what a tick already billed through',
      should: 'leave the later watermark alone — the reset is monotonic, never an assignment',
      actual: store.rows.get(ENV_ID)?.storageLastBilledAt,
      expected: alreadyBilledThrough,
    });
  });

  it('still moves the watermark FORWARD on an ordinary provision', async () => {
    const row = makeEnvRow({ storageLastBilledAt: new Date(NOW.getTime() - 60_000) });
    const store = makeEnvStore([row]);
    const host = makeSpriteHost();

    await ensureSpriteHolderSandbox({ row, intent: 'ensure', deps: makeEnvDeps({ store, host }) });

    assert({
      given: 'a provision on a holder whose watermark predates it',
      should: 'advance it — a new generation must not inherit the dead one\'s window',
      actual: store.rows.get(ENV_ID)?.storageLastBilledAt,
      expected: NOW,
    });
  });
});
