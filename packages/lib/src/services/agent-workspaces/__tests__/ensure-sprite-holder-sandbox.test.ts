/**
 * The provisioning core, driven by a holder that is NOT a session.
 *
 * Every other suite in this directory reaches the core through
 * `ensureAgentSessionSandbox`, which proves the session path still works but
 * cannot prove the thing the refactor actually claims: that the core carries no
 * session assumptions. If the only caller is the session wrapper, "holder-neutral"
 * is an assertion about code nobody has run any other way.
 *
 * So this suite stands up a BOX holder — a bare `SpriteHolderStore` over a row
 * map, keys derived with `deriveDriveBoxSpriteKey`, no `AgentSessionStore`, no
 * `ownerId`, no actor, no session secret — and drives `ensureSpriteHolderSandbox`
 * directly. It is also the standing regression test for Phase 3's central
 * invariant: two sessions opening in one box must land on ONE VM, which is the
 * CAS's job and nothing else's.
 */

import { describe, it, expect } from 'vitest';
import { ensureSpriteHolderSandbox, type SpriteHolderProvisionDeps, type SpriteHolderStore } from '../agent-workspace-sprite';
import type { SpriteHolderLifecycleRow } from '../../../agent-workspaces/plan-workspace-lifecycle';
import { stampColumns } from '../agent-workspaces-store';
import { deriveDriveBoxSpriteKey } from '../../../drive-boxes/box-sprite-key';
import { makeSpriteHost, NOW, SECRET, TENANT_ID, type FakeSpriteHost } from './fakes';

const BOX_ID = 'box-1';
const BOX_KEY = deriveDriveBoxSpriteKey({ tenantId: TENANT_ID, boxId: BOX_ID, secret: SECRET });

function makeBoxRow(over: Partial<SpriteHolderLifecycleRow> = {}): SpriteHolderLifecycleRow {
  return {
    holderId: BOX_ID,
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

interface FakeBoxStore {
  store: SpriteHolderStore;
  rows: Map<string, SpriteHolderLifecycleRow>;
  reclaims: Map<string, string | null>;
}

/**
 * A box-shaped holder store with the REAL identity CAS — the same discipline the
 * session fake keeps, for the same reason: a fake that accepts writes the
 * production CAS would refuse makes every concurrency test agree with a bug.
 */
function makeBoxStore(seed: SpriteHolderLifecycleRow[] = [makeBoxRow()]): FakeBoxStore {
  const rows = new Map(seed.map((row) => [row.holderId, row]));
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

function makeBoxDeps(
  fakes: { store: FakeBoxStore; host: FakeSpriteHost },
  over: Partial<SpriteHolderProvisionDeps> = {},
): SpriteHolderProvisionDeps {
  return {
    store: fakes.store.store,
    host: fakes.host.host,
    substrate: { kind: 'sprite' },
    options: {},
    deriveSpriteKey: (holderId) => deriveDriveBoxSpriteKey({ tenantId: TENANT_ID, boxId: holderId, secret: SECRET }),
    authorize: async () => ({ ok: true }),
    checkFullEgressEnablement: async () => ({ ok: true }),
    checkQuota: async () => ({ allowed: true }),
    now: () => NOW,
    ...over,
  };
}

describe('ensureSpriteHolderSandbox — a non-session holder', () => {
  it('should provision under the HOLDER-supplied key, never a session key', async () => {
    // The key-derivation seam is the whole reason box names cannot collide with
    // reclaim-pending session names. If the core reached for the session
    // derivation, this name would carry `pgs-ses-`.
    const store = makeBoxStore();
    const host = makeSpriteHost();
    const result = await ensureSpriteHolderSandbox({
      row: makeBoxRow(),
      intent: 'ensure',
      deps: makeBoxDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: BOX_KEY, resumed: false });
    expect(host.calls.provision[0].name).toBe(BOX_KEY);
    expect(BOX_KEY.startsWith('pgs-box-')).toBe(true);
    expect(store.rows.get(BOX_ID)!.spriteKey).toBe(BOX_KEY);
  });

  it('given two concurrent first-ensures of ONE box, should yield ONE VM (the Phase 3 shared-filesystem invariant)', async () => {
    // This is the case the provisioner's docblock exists for. Two sessions
    // opening in the same box at the same moment must not mint two VMs: the
    // host is name-keyed so both hold the same physical Sprite, and the CAS
    // decides which one records it. The loser must resume onto the winner's VM,
    // not kill it — killing it would take down the filesystem both sessions are
    // about to share.
    const store = makeBoxStore();
    const host = makeSpriteHost();
    const deps = makeBoxDeps({ store, host });

    const [a, b] = await Promise.all([
      ensureSpriteHolderSandbox({ row: makeBoxRow(), intent: 'ensure', deps }),
      ensureSpriteHolderSandbox({ row: makeBoxRow(), intent: 'ensure', deps }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.ok && a.sandboxId).toBe(BOX_KEY);
    expect(b.ok && b.sandboxId).toBe(BOX_KEY);
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

  it('given an already-provisioned box, should RESUME its Sprite rather than mint another', async () => {
    const store = makeBoxStore([makeBoxRow({ spriteKey: BOX_KEY, sandboxId: BOX_KEY, spriteInstanceId: `inst-${BOX_KEY}` })]);
    const host = makeSpriteHost({ seed: { [BOX_KEY]: { instanceId: `inst-${BOX_KEY}` } } });

    const result = await ensureSpriteHolderSandbox({
      row: store.rows.get(BOX_ID)!,
      intent: 'ensure',
      deps: makeBoxDeps({ store, host }),
    });

    expect(result).toEqual({ ok: true, sandboxId: BOX_KEY, resumed: true });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given two DIFFERENT boxes, should provision two distinct Sprites', async () => {
    const store = makeBoxStore([makeBoxRow({ holderId: 'box-a' }), makeBoxRow({ holderId: 'box-b' })]);
    const host = makeSpriteHost();
    const deps = makeBoxDeps({ store, host });

    const a = await ensureSpriteHolderSandbox({ row: makeBoxRow({ holderId: 'box-a' }), intent: 'ensure', deps });
    const b = await ensureSpriteHolderSandbox({ row: makeBoxRow({ holderId: 'box-b' }), intent: 'ensure', deps });

    expect(a.ok && b.ok && a.sandboxId).not.toBe(b.ok && b.sandboxId);
    expect(host.live.size).toBe(2);
  });

  it('given an unauthorized actor, should deny BEFORE touching the host', async () => {
    // The authorize seam is holder-neutral too: the core never learns who the
    // actor is, only whether the wrapper says yes.
    const store = makeBoxStore();
    const host = makeSpriteHost();
    const result = await ensureSpriteHolderSandbox({
      row: makeBoxRow(),
      intent: 'ensure',
      deps: makeBoxDeps({ store, host }, { authorize: async () => ({ ok: false, reason: 'no_box_access' }) }),
    });

    expect(result).toEqual({ ok: false, reason: 'denied', denial: 'not_authorized', detail: 'no_box_access' });
    expect(host.calls.provision).toHaveLength(0);
  });

  it("should surface the holder's OWN quota verdict — both halves, the core invents neither", async () => {
    // The core hardcodes no part of a quota refusal. It used to bake in
    // `denial: 'session_limit_reached'`, which would have labelled a BOX's
    // refusal a live-session ceiling — wrong on the wire and wrong in the
    // security audit. Both halves are the holder's to name, and this pins that:
    // a refusal reports back exactly what `checkQuota` said, nothing defaulted.
    const store = makeBoxStore();
    const host = makeSpriteHost();
    const deps = makeBoxDeps(
      { store, host },
      {
        checkQuota: async () => ({
          allowed: false,
          denial: 'not_authorized',
          reason: 'box limit reached for this drive',
        }),
      },
    );

    const result = await ensureSpriteHolderSandbox({ row: makeBoxRow(), intent: 'ensure', deps });

    expect(result).toEqual({
      ok: false,
      reason: 'denied',
      // Deliberately NOT `session_limit_reached`: a value the core could only
      // have produced by passing the holder's own answer through.
      denial: 'not_authorized',
      detail: 'box limit reached for this drive',
    });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given the egress gate refuses, should not provision', async () => {
    const store = makeBoxStore();
    const host = makeSpriteHost();
    const result = await ensureSpriteHolderSandbox({
      row: makeBoxRow(),
      intent: 'ensure',
      deps: makeBoxDeps(
        { store, host },
        { checkFullEgressEnablement: async () => ({ ok: false, reason: 'containment_unverified' }) },
      ),
    });

    expect(result).toEqual({ ok: false, reason: 'egress_denied', detail: 'containment_unverified' });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('given attach on a box that has never provisioned, should deny — attach never mints', async () => {
    const store = makeBoxStore();
    const host = makeSpriteHost();
    const result = await ensureSpriteHolderSandbox({
      row: makeBoxRow(),
      intent: 'attach',
      deps: makeBoxDeps({ store, host }),
    });

    expect(result).toEqual({ ok: false, reason: 'denied', denial: 'sandbox_not_provisioned' });
    expect(host.calls.provision).toHaveLength(0);
  });

  it('should measure storage opportunistically, keyed by HOLDER id', async () => {
    const store = makeBoxStore();
    const host = makeSpriteHost();
    const measured: string[] = [];
    await ensureSpriteHolderSandbox({
      row: makeBoxRow(),
      intent: 'ensure',
      deps: makeBoxDeps(
        { store, host },
        {
          measureStorage: async ({ holderId }) => {
            measured.push(holderId);
          },
        },
      ),
    });

    expect(measured).toEqual([BOX_ID]);
  });
});
