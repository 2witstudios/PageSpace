/**
 * The env provisioning WIRING — the seams `ensureSpriteHolderSandbox` is handed.
 *
 * The provisioning core is deliberately holder-agnostic: it derives no Sprite
 * key, resolves no tenant, and picks no authorization gate of its own. Every one
 * of those is injected, which means the env's correctness on those axes lives
 * HERE, in one small builder, and nowhere else. Two of them are silent if wrong:
 *
 *  - **The keyspace.** Session keys fold `agent-session-sprite:v2`, envs fold
 *    `drive-env-sprite:v1`. Wiring the session derivation here would put env
 *    names and session names in ONE keyspace, where an env could derive the name
 *    of a session Sprite still awaiting reclaim and provision straight onto a VM
 *    the reclaim outbox is about to kill. Nothing downstream would notice.
 *  - **The tenant.** The fold's tenant is the DRIVE OWNER. Using the requester
 *    would give one env two different Sprite identities depending on who touched
 *    it — the same split `resolveSessionTenantId` fails closed to avoid.
 *
 * These assertions used to live in `apps/web`, when the web app's rebuild verb
 * was the only caller. They moved here with the builder itself: there are three
 * callers now across two processes (rebuild, a web session's ensure, a realtime
 * shell's ensure), and pinning the decisions in one app's suite would leave the
 * other process free to drift.
 *
 * It asserts what the wiring PASSES, not what the core does with it — the core
 * has its own suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Typed FROM the real export rather than hand-shaped: `authorize` below narrows
// on this result, so a change to what `canRunCode` answers should break this
// file rather than let the mock keep promising a shape the gate no longer
// returns.
type CanRunCode = typeof import('../../sandbox/can-run-code').canRunCode;
const canRunCode = vi.fn<CanRunCode>(async () => ({ ok: true }));
vi.mock('../../sandbox/can-run-code', () => ({
  canRunCode: (...args: Parameters<CanRunCode>) => canRunCode(...args),
  isCodeExecutionEnabled: () => true,
}));

import { buildEnvProvisionDeps, ensureDriveEnvSandbox } from '../env-provision-deps';
import { makeLocalRecord } from './fakes';
import { deriveDriveEnvSpriteKey } from '../../../drive-envs/env-sprite-key';
import { deriveAgentSessionSpriteKey } from '../../../agent-workspaces/workspace-sprite-key';
import type { DriveEnvRecord, DriveEnvStore } from '../drive-envs-store';
import {
  localEnvSandboxId,
  LOCAL_ENV_SANDBOX_CAPABILITIES,
  LocalEnvNotConnectedError,
  type SandboxHandle,
  type SandboxHost,
} from '../../sandbox/sandbox-host';

const ENV_ID = 'env-1';
const DRIVE_ID = 'drive-1';
const DRIVE_OWNER_ID = 'owner-1';
const REQUESTER_ID = 'requester-9';
/** >= 32 chars — every key derivation refuses anything shorter. */
const SECRET = 'x'.repeat(40);

const envRow = {
  id: ENV_ID,
  driveId: DRIVE_ID,
  name: 'staging',
  createdBy: DRIVE_OWNER_ID,
  substrate: 'sprite',
  visibleToGlobalAssistant: false,
  spriteKey: null,
  sandboxId: null,
  spriteInstanceId: null,
  egressPolicyToken: null,
  teardownRequestedAt: null,
  spriteTornDownAt: null,
  storageLastBilledAt: new Date(),
  storageMeasuredBytes: null,
  storageMeasuredAt: null,
  lastActiveAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} satisfies DriveEnvRecord;

const noopStore = {
  updateSpriteIdentity: vi.fn(async () => true),
  applyStamps: vi.fn(async () => true),
  reloadSpritePointer: vi.fn(async () => null),
  enqueueReclaim: vi.fn(async () => {}),
  // Answers whether its compare-and-swap wrote, exactly like the real store — a
  // mock resolving `undefined` is falsy and would silently exercise the
  // CAS-REFUSED branch while a "was it called" assertion still passed.
  recordStorageMeasurement:
    vi.fn<(input: Parameters<DriveEnvStore['recordStorageMeasurement']>[0]) => Promise<boolean>>(async () => true),
};

const noopHost = {} as SandboxHost;

function deps(tier: 'pro' | 'free' = 'pro') {
  return buildEnvProvisionDeps({
    row: envRow,
    payer: { payerId: DRIVE_OWNER_ID, tier },
    requesterId: REQUESTER_ID,
    store: noopStore,
    host: noopHost,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  canRunCode.mockResolvedValue({ ok: true });
  process.env.SANDBOX_SESSION_SECRET = SECRET;
  // Containment verified, so the Sprite path reaches the HOST in this harness —
  // which is what makes "the host was never called" a load-bearing assertion
  // for the local-env rows below rather than an artifact of an earlier refusal.
  process.env.SANDBOX_CONTAINMENT_VERIFIED = 'true';
});

describe('buildEnvProvisionDeps', () => {
  it('should fold the Sprite key in the ENV keyspace, tenanted on the DRIVE OWNER', () => {
    const derived = deps().deriveSpriteKey(ENV_ID);
    expect(derived).toBe(deriveDriveEnvSpriteKey({ tenantId: DRIVE_OWNER_ID, envId: ENV_ID, secret: SECRET }));
    expect(derived.startsWith('pgs-env-')).toBe(true);
  });

  it('should NEVER derive a session name for an env — one keyspace would let an env land on a session VM awaiting reclaim', () => {
    expect(deps().deriveSpriteKey(ENV_ID)).not.toBe(
      deriveAgentSessionSpriteKey({ tenantId: DRIVE_OWNER_ID, workspaceId: ENV_ID, secret: SECRET }),
    );
  });

  it('should NOT tenant the fold on the requester — one env must not have two Sprite identities', () => {
    expect(deps().deriveSpriteKey(ENV_ID)).not.toBe(
      deriveDriveEnvSpriteKey({ tenantId: REQUESTER_ID, envId: ENV_ID, secret: SECRET }),
    );
  });

  it("should authorize the REQUESTER against the env's drive, billed to the drive owner", async () => {
    await deps().authorize();

    expect(canRunCode).toHaveBeenCalledWith({
      userId: REQUESTER_ID,
      driveId: DRIVE_ID,
      ownerId: DRIVE_OWNER_ID,
      requestOrigin: 'user',
    });
  });

  it('given the actor may not run code here, should surface the refusal as the denial detail', async () => {
    // A REAL `CodeExecutionDenialReason`. The mock used to answer
    // `'not_a_member'`, which the gate has never returned — the assertion passed
    // because it compared the fabrication to itself, proving only that the
    // adapter copies a string. Typing the mock from the export is what surfaced
    // it.
    canRunCode.mockResolvedValue({ ok: false, reason: 'no_drive_access' });
    expect(await deps().authorize()).toEqual({ ok: false, reason: 'no_drive_access' });
  });

  it('given a payer whose tier lost sandbox access, should refuse at the mint site', async () => {
    expect(await deps('free').checkQuota({ alreadyProvisioned: false })).toEqual({
      allowed: false,
      denial: 'not_authorized',
      reason: 'tier_ineligible',
    });
  });

  it('given an eligible payer, should let the mint through — the env ALLOWANCE is metered at create, not here', async () => {
    expect(await deps().checkQuota({ alreadyProvisioned: false })).toEqual({ allowed: true });
  });

  it('should address the store by envId — the adapter that makes an env a second holder of the ONE CAS', async () => {
    const stamps = { lastActiveAt: new Date() };
    await deps().store.applyStamps({ holderId: ENV_ID, stamps });
    expect(noopStore.applyStamps).toHaveBeenCalledWith({ envId: ENV_ID, stamps, cas: undefined });
  });

  /**
   * The measurement seam — the WRITE side of the meter that bills this env.
   *
   * These assertions moved here from `apps/web` with the builder itself, and the
   * move is the point rather than tidying: the storage reconcile only READS
   * `drive_envs.storageMeasuredBytes`, so an env whose provisioning deps carry no
   * writer prices at the never-measured 0 floor forever while the cron keeps
   * advancing its watermark. No error, no failing test — an environment that is
   * silently free. Pinning it at the ONE builder every process reaches is what
   * stops a second composition forgetting it; pinning it in one app's suite would
   * have left the other tier free to drift.
   */
  it('should wire a measureStorage seam at all — without one an env bills the 0 floor forever', () => {
    expect(typeof deps().measureStorage).toBe('function');
  });

  it("should wire it to THIS env's store, so the bytes land on the env row", async () => {
    const handle = {
      spriteInstanceId: 'inst-1',
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '2000000000\t/workspace\n', stderr: '' })),
    };

    await deps().measureStorage?.({ holderId: ENV_ID, handle: handle as never });

    expect(noopStore.recordStorageMeasurement).toHaveBeenCalledTimes(1);
    expect(noopStore.recordStorageMeasurement.mock.calls[0][0]).toMatchObject({
      envId: ENV_ID,
      spriteInstanceId: 'inst-1',
      measuredBytes: 2_000_000_000,
    });
  });
});

describe('ensureDriveEnvSandbox', () => {
  it('given a vanished env, should fail closed rather than provision something', async () => {
    const result = await ensureDriveEnvSandbox({
      envId: ENV_ID,
      intent: 'ensure',
      requesterId: REQUESTER_ID,
      deps: {
        store: { ...noopStore, findById: async () => null, findLocalByEnvId: async () => null },
        host: noopHost,
        resolvePayer: async () => ({ payerId: DRIVE_OWNER_ID, tier: 'pro' }),
      },
    });

    expect(result).toEqual({ ok: false, reason: 'provision_failed', detail: 'env_not_found' });
  });

  it('given a vanished DRIVE, should fail closed rather than fold under another tenant', async () => {
    // A fallback payer would derive a different Sprite NAME for this env, which
    // is a second machine, not a second guess.
    let resolved = 0;
    const result = await ensureDriveEnvSandbox({
      envId: ENV_ID,
      intent: 'ensure',
      requesterId: REQUESTER_ID,
      deps: {
        store: { ...noopStore, findById: async () => envRow, findLocalByEnvId: async () => null },
        host: noopHost,
        resolvePayer: async () => {
          resolved += 1;
          return null;
        },
      },
    });

    expect(resolved).toBe(1);
    expect(result).toEqual({ ok: false, reason: 'provision_failed', detail: 'drive_not_found' });
  });

  /**
   * C1 (Codex): a LOCAL env used to fall straight into the Sprite provisioning
   * path — the t05 CHECK would have failed it mid-provision, AFTER a VM was
   * minted. The gate now refuses before the host is ever touched. Each row
   * asserts the NEGATIVE explicitly: the Sprite host's `provision` is never
   * called. (A mutant that skips the branch mints a Sprite and goes red here.)
   */
  describe('a LOCAL env never reaches the Sprite host (C1)', () => {
    const localRow = { ...envRow, substrate: 'local' as const };
    const sibling = (over: Partial<ReturnType<typeof makeLocalRecord>> = {}) =>
      makeLocalRecord({ envId: ENV_ID, driveId: DRIVE_ID, ownerId: REQUESTER_ID, enrolledAt: new Date(), machinePublicKey: 'pk', machineKeyFingerprint: 'fp', serverKeyId: 'k1', lastSeenAt: new Date(), ...over });

    function spyHost() {
      const provision = vi.fn(async () => ({ sandboxId: 'pgs-should-never-exist', spriteInstanceId: 'inst-x' }));
      const attach = vi.fn(async () => null);
      return { host: { provision, attach, kill: vi.fn() } as unknown as SandboxHost, provision, attach };
    }

    /**
     * A stand-in for the local `SandboxHost` the registry builds in apps/web.
     * It is a SEPARATE spy from the Sprite host, which is what lets every row
     * below assert the negative — the Sprite host is never touched — while the
     * CONTROL row proves the harness genuinely does reach it for a Sprite env.
     */
    function spyLocalHost(over: Partial<SandboxHost> = {}) {
      const provision = vi.fn(
        async (_args: Parameters<SandboxHost['provision']>[0]) =>
          ({ sandboxId: localEnvSandboxId(ENV_ID), spriteInstanceId: 'epoch-1', capabilities: LOCAL_ENV_SANDBOX_CAPABILITIES }) as unknown as SandboxHandle,
      );
      const host = { provision, attach: vi.fn(async () => null), kill: vi.fn(async () => {}), ...over } as unknown as SandboxHost;
      const resolveLocalHost = vi.fn(async () => host);
      return { host, provision, resolveLocalHost };
    }

    async function ensureLocal(input: {
      sibling: ReturnType<typeof makeLocalRecord> | null;
      liveConnection?: () => 'connecting' | 'connected' | null;
      flag?: boolean;
      role?: 'admin' | 'member';
      local?: ReturnType<typeof spyLocalHost> | null;
    }) {
      const host = spyHost();
      const local = input.local === undefined ? spyLocalHost() : input.local;
      const result = await ensureDriveEnvSandbox({
        envId: ENV_ID,
        intent: 'ensure',
        requesterId: REQUESTER_ID,
        deps: {
          store: { ...noopStore, findById: async () => localRow, findLocalByEnvId: async () => input.sibling },
          host: host.host,
          resolvePayer: async () => ({ payerId: DRIVE_OWNER_ID, tier: 'pro' }),
          liveConnection: input.liveConnection ?? (() => 'connected'),
          localEnvsEnabled: input.flag ?? true,
          ...(local ? { resolveLocalHost: local.resolveLocalHost } : {}),
        },
      });
      return { result, host, local };
    }

    it('given a connected, enrolled machine the owner may bind to, should provision through the LOCAL host and NOT the Sprite host (t09)', async () => {
      const { result, host, local } = await ensureLocal({ sibling: sibling() });

      expect(result).toEqual({ ok: true, sandboxId: localEnvSandboxId(ENV_ID), resumed: true });
      expect(local!.provision).toHaveBeenCalledTimes(1);
      expect(local!.provision.mock.calls[0][0]).toMatchObject({ name: ENV_ID, substrate: { kind: 'local', envId: ENV_ID } });
      expect(host.provision).not.toHaveBeenCalled();
      expect(host.attach).not.toHaveBeenCalled();
    });

    it('should report the bind as RESUMED — PageSpace did not create this machine and could not have', async () => {
      const { result } = await ensureLocal({ sibling: sibling() });
      expect(result).toMatchObject({ ok: true, resumed: true });
    });

    /**
     * Invariant 9: a local env's Sprite columns stay NULL, which is the whole
     * reason it is structurally invisible to reclaim, storage billing and the
     * egress predicates. A single identity/stamp/reclaim write here would put
     * it back into queries that must never see it.
     */
    it('should write NOTHING to the row — no identity CAS, no stamps, no reclaim, no storage measurement', async () => {
      await ensureLocal({ sibling: sibling() });

      expect(noopStore.updateSpriteIdentity).not.toHaveBeenCalled();
      expect(noopStore.applyStamps).not.toHaveBeenCalled();
      expect(noopStore.enqueueReclaim).not.toHaveBeenCalled();
      expect(noopStore.recordStorageMeasurement).not.toHaveBeenCalled();
    });

    /**
     * `substrate_unsupported` survives t09 with ONE narrowed meaning: this
     * PROCESS cannot reach local environments. The bridge socket terminates in
     * apps/web and the realtime tier runs this same function, so it must
     * refuse rather than fall through to `deps.host` — the Sprite host. It is
     * easy to mistake for the old blanket refusal, so the distinction is
     * pinned: an allowed, connected machine reaches this verdict ONLY when the
     * registry seam is absent, and the same row WITH the seam binds.
     */
    it('given this PROCESS holds no bridge registry (the realtime tier), should refuse substrate_unsupported rather than fall through to the Sprite host', async () => {
      const { result, host } = await ensureLocal({ sibling: sibling(), local: null });
      expect(result).toEqual({ ok: false, reason: 'local_refused', refusal: 'substrate_unsupported', detail: 'substrate_unsupported' });
      expect(host.provision).not.toHaveBeenCalled();
    });

    it('substrate_unsupported should mean ONLY that — the identical row binds as soon as the registry seam is supplied', async () => {
      const withoutRegistry = await ensureLocal({ sibling: sibling(), local: null });
      const withRegistry = await ensureLocal({ sibling: sibling() });

      expect(withoutRegistry.result).toMatchObject({ ok: false, refusal: 'substrate_unsupported' });
      expect(withRegistry.result).toMatchObject({ ok: true });
    });

    /**
     * Invariant 9, stated as the thing that would break it. The address a
     * local bind hands back is DERIVED — `local-env:<envId>` — and it exists
     * only inside the request. Persisting it anywhere would put the row into
     * the reclaim, storage-billing and egress predicates that key on those
     * columns, which is exactly the visibility a local env must never have.
     */
    it('should never hand the derived address to the STORE — not as a Sprite pointer, not in any other argument', async () => {
      const { result } = await ensureLocal({ sibling: sibling() });
      expect(result).toMatchObject({ ok: true, sandboxId: localEnvSandboxId(ENV_ID) });

      const everyArgument = JSON.stringify(
        Object.values(noopStore).map((fn) => fn.mock.calls),
      );
      expect(everyArgument).not.toContain(localEnvSandboxId(ENV_ID));
      expect(everyArgument).not.toContain('local-env:');
    });

    it("should leave the row's sandboxId NULL after a bind, an exec and a reconnect", async () => {
      const local = spyLocalHost();
      const { result } = await ensureLocal({ sibling: sibling(), local });
      if (!result.ok) throw new Error(`expected a bind, got ${JSON.stringify(result)}`);

      // The full round trip a tool call makes: bind, run, re-open by address.
      const handle = await local.host.provision({ name: ENV_ID, substrate: { kind: 'local', envId: ENV_ID }, options: {} });
      await local.host.attach({ sandboxId: handle.sandboxId });

      // The row this env provisioned from is unchanged: t05's CHECK keeps these
      // NULL, and nothing here even attempted to write them.
      expect(localRow.sandboxId).toBeNull();
      expect(localRow.spriteInstanceId).toBeNull();
      expect(localRow.spriteKey).toBeNull();
      expect(noopStore.updateSpriteIdentity).not.toHaveBeenCalled();
      expect(noopStore.enqueueReclaim).not.toHaveBeenCalled();
    });

    it('given the connection drops between the gate and the bind, should answer the SAME not_connected word the gate would have used', async () => {
      const local = spyLocalHost({
        provision: vi.fn(async () => {
          throw new LocalEnvNotConnectedError(ENV_ID);
        }) as unknown as SandboxHost['provision'],
      });
      const { result, host } = await ensureLocal({ sibling: sibling(), local });
      expect(result).toEqual({ ok: false, reason: 'local_refused', refusal: 'not_connected', detail: 'not_connected' });
      expect(host.provision).not.toHaveBeenCalled();
    });

    it('given the machine is NOT connected, should answer the typed not_connected — never a Sprite provision, never a queue', async () => {
      const { result, host, local } = await ensureLocal({ sibling: sibling({ lastSeenAt: null }), liveConnection: () => null });
      expect(result).toEqual({ ok: false, reason: 'local_refused', refusal: 'not_connected', detail: 'not_connected' });
      expect(host.provision).not.toHaveBeenCalled();
      expect(local!.resolveLocalHost).not.toHaveBeenCalled();
    });

    it('given a revoked machine, should answer revoked and touch no host', async () => {
      const { result, host } = await ensureLocal({ sibling: sibling({ revokedAt: new Date() }) });
      expect(result).toMatchObject({ ok: false, reason: 'local_refused', refusal: 'revoked' });
      expect(host.provision).not.toHaveBeenCalled();
    });

    it('given LOCAL_ENVS_ENABLED off, should answer flag_disabled (invariant 11) and touch no host', async () => {
      const { result, host, local } = await ensureLocal({ sibling: sibling(), flag: false });
      expect(result).toMatchObject({ ok: false, reason: 'local_refused', refusal: 'flag_disabled' });
      expect(host.provision).not.toHaveBeenCalled();
      // Requirement: with the flag unset NO local host is ever constructed.
      expect(local!.resolveLocalHost).not.toHaveBeenCalled();
      expect(local!.provision).not.toHaveBeenCalled();
    });

    it('given canRunCode denies, should answer code_exec_denied with the cause as detail — the base gate is consulted with the DRIVE OWNER as payer', async () => {
      canRunCode.mockResolvedValue({ ok: false, reason: 'no_drive_access' });
      const { result, host } = await ensureLocal({ sibling: sibling() });
      expect(result).toEqual({ ok: false, reason: 'local_refused', refusal: 'code_exec_denied', detail: 'no_drive_access' });
      expect(canRunCode).toHaveBeenCalledWith({ userId: REQUESTER_ID, driveId: DRIVE_ID, ownerId: DRIVE_OWNER_ID, requestOrigin: 'user' });
      expect(host.provision).not.toHaveBeenCalled();
    });

    it("given a requester who is not the machine's owner under owner-only policy, should answer bind_policy", async () => {
      const { result, host, local } = await ensureLocal({ sibling: sibling({ ownerId: 'someone-else' }), role: 'admin' });
      expect(result).toMatchObject({ ok: false, reason: 'local_refused', refusal: 'bind_policy' });
      expect(host.provision).not.toHaveBeenCalled();
      expect(local!.resolveLocalHost).not.toHaveBeenCalled();
    });

    it('given a local env whose sibling is gone (owner erased), should answer revoked and touch no host', async () => {
      const { result, host } = await ensureLocal({ sibling: null });
      expect(result).toMatchObject({ ok: false, reason: 'local_refused', refusal: 'revoked' });
      expect(host.provision).not.toHaveBeenCalled();
    });

    it('CONTROL: the same row as a Sprite env DOES reach the Sprite host — proving the negative rows above are load-bearing', async () => {
      const host = spyHost();
      const control = await ensureDriveEnvSandbox({
        envId: ENV_ID,
        intent: 'ensure',
        requesterId: REQUESTER_ID,
        deps: {
          store: { ...noopStore, findById: async () => envRow, findLocalByEnvId: async () => null },
          host: host.host,
          resolvePayer: async () => ({ payerId: DRIVE_OWNER_ID, tier: 'pro' }),
        },
      });
      expect(control.ok, JSON.stringify(control)).toBe(true);
      expect(host.provision).toHaveBeenCalledTimes(1);
    });
  });
});
