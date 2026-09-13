/**
 * In-memory fakes for the drive-environment services — same discipline as
 * `services/agent-workspaces/__tests__/fakes.ts`: every test here runs with NO
 * database and NO live Sprite.
 *
 * The store fake implements the REAL compare-and-swap semantics (identity CAS on
 * the previous pointer, teardown CAS on the instance) and the REAL unique
 * `(driveId, name)` constraint, because those are the things the service's
 * ordering has to survive. The Sprite host is the SESSION suite's fake, imported
 * rather than re-written: it already models the name-keyed provisioning contract
 * (two provisions of one name hand back one physical VM) and the
 * replaced-instance kill refusal, and an env is the same kind of Sprite holder.
 */

import type { DriveEnvRecord, DriveEnvStore, DriveEnvLocalRecord } from '../drive-envs-store';
import { envStampColumns } from '../drive-envs-store';

export { makeSpriteHost } from '../../agent-workspaces/__tests__/fakes';

export const NOW = new Date('2026-08-17T12:00:00.000Z');
export const ENV_ID = 'env-1';
export const DRIVE_ID = 'drive-1';
export const PAYER_ID = 'owner-1';

export function makeEnvRecord(over: Partial<DriveEnvRecord> = {}): DriveEnvRecord {
  return {
    id: ENV_ID,
    substrate: 'sprite',
    driveId: DRIVE_ID,
    name: 'staging',
    createdBy: 'user-1',
    // Default OFF — the absence of a value is never a grant (leaf A).
    visibleToGlobalAssistant: false,
    spriteKey: null,
    sandboxId: null,
    spriteInstanceId: null,
    egressPolicyToken: null,
    teardownRequestedAt: null,
    spriteTornDownAt: null,
    storageLastBilledAt: NOW,
    storageMeasuredBytes: null,
    storageMeasuredAt: null,
    lastActiveAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

export function makeLocalRecord(over: Partial<DriveEnvLocalRecord> = {}): DriveEnvLocalRecord {
  return {
    envId: ENV_ID,
    driveId: DRIVE_ID,
    ownerId: 'user-1',
    label: 'jono-macstudio',
    enrollmentId: 'enr-1',
    machinePublicKey: null,
    machineKeyFingerprint: null,
    serverKeyId: null,
    capabilities: null,
    daemonEpoch: null,
    // A MINTED row always carries the dialog's explicit policy (GA wave 1);
    // the column's deny-all default is the backstop for a row some path
    // forgot. Tests that want the backstop set `{ ops: [] }` explicitly.
    serverPolicy: { ops: ['fs_read', 'fs_write', 'exec'], checkpoint: false },
    /** Pinned by `pinMachineKey` at enrolment (hardening B); NULL before that, exactly as the column is. */
    ownerCredentials: null,
    bindPolicy: 'owner',
    enrollmentCodeHash: null,
    enrollmentCodeExpiresAt: null,
    enrollmentCodeUsedAt: null,
    challengeNonce: null,
    challengeIssuedAt: null,
    challengeExpiresAt: null,
    challengeUsedAt: null,
    lastSeenAt: null,
    enrolledAt: null,
    revokedAt: null,
    pausedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

export interface FakeDriveEnvStore {
  store: DriveEnvStore;
  rows: Map<string, DriveEnvRecord>;
  /** Models `drive_env_local`: envId → the sibling lifecycle row. */
  local: Map<string, DriveEnvLocalRecord>;
  /** Models `machine_sprite_reclaims`: sandboxId → spriteInstanceId. */
  reclaims: Map<string, string | null>;
  /** envId → live (not-ended) session count, the delete guard's input. */
  liveSessions: Map<string, number>;
  /** payerId → envs owned across their drives, the quota's input. */
  ownedEnvs: Map<string, number>;
  calls: { deleteIfUnoccupied: number; requestTeardown: number; stampSpriteTornDown: number };
}

/** Which drives a user owns or has accepted membership of — the fake's stand-in for the members join. */
const driveMemberships = new Map<string, Set<string>>();

/** Declare a user as a member of a drive, for `listSpriteEnvsInUserDrives`. */
export function grantDriveMembership(userId: string, driveId: string): void {
  const drives = driveMemberships.get(userId) ?? new Set<string>();
  drives.add(driveId);
  driveMemberships.set(userId, drives);
}

export function makeDriveEnvStore(seed: DriveEnvRecord[] = [], now: () => Date = () => NOW): FakeDriveEnvStore {
  const rows = new Map<string, DriveEnvRecord>();
  for (const row of seed) rows.set(row.id, row);
  const local = new Map<string, DriveEnvLocalRecord>();
  const reclaims = new Map<string, string | null>();
  const liveSessions = new Map<string, number>();
  const ownedEnvs = new Map<string, number>();
  const calls = { deleteIfUnoccupied: 0, requestTeardown: 0, stampSpriteTornDown: 0 };
  let minted = 0;

  /** The `(driveId, name)` unique index, modelled — a duplicate is an ANSWER, not a throw. */
  function nameTaken(driveId: string, name: string, exceptId?: string): boolean {
    for (const row of rows.values()) {
      if (row.driveId === driveId && row.name === name && row.id !== exceptId) return true;
    }
    return false;
  }

  const store: DriveEnvStore = {
    async findById(envId) {
      return rows.get(envId) ?? null;
    },

    async list(driveId) {
      return [...rows.values()]
        .filter((row) => row.driveId === driveId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    async createIfUnderLimit({ driveId, name, createdBy, now: at, payerId, maxEnvs, local: facts }) {
      if (nameTaken(driveId, name)) return { ok: false, reason: 'name_taken' };
      // The structural ceiling, modelled: the fake's map IS the serialized
      // count, so a create past the limit loses here exactly as the advisory
      // -locked count-and-insert makes it lose in Postgres.
      if ((ownedEnvs.get(payerId) ?? 0) >= maxEnvs) return { ok: false, reason: 'limit_reached' };
      minted += 1;
      const row = makeEnvRecord({
        id: `env-${minted}`,
        substrate: facts ? 'local' : 'sprite',
        driveId,
        name,
        createdBy,
        storageLastBilledAt: at,
        createdAt: at,
        updatedAt: at,
      });
      rows.set(row.id, row);
      if (!facts) return { ok: true, env: row, local: null };
      // The sibling lands in the SAME step as the env — one transaction in
      // Postgres, one map write here — so a local env never exists without it.
      const sibling = makeLocalRecord({ envId: row.id, driveId, ...facts, createdAt: at, updatedAt: at });
      local.set(row.id, sibling);
      return { ok: true, env: row, local: sibling };
    },

    async findLocalByEnrollmentId(enrollmentId) {
      for (const sibling of local.values()) if (sibling.enrollmentId === enrollmentId) return sibling;
      return null;
    },

    async findLocalByEnvId(envId) {
      return local.get(envId) ?? null;
    },

    async listLocalFacts(driveId) {
      return [...local.values()].filter((sibling) => sibling.driveId === driveId);
    },

    async listLocalByOwner(ownerId) {
      return [...local.values()].filter((sibling) => sibling.ownerId === ownerId).flatMap((sibling) => { const env = rows.get(sibling.envId); return env ? [{ env, local: sibling }] : []; });
    },

    async pinMachineKey({ envId, machinePublicKey, machineKeyFingerprint, serverKeyId, ownerCredentials, enrollmentCodeHash, now: at }) {
      const sibling = local.get(envId);
      // The real store's compare-and-set: only a pending, unrevoked row with an
      // unconsumed code — still the code that was VERIFIED — may be enrolled,
      // and enrolling consumes the code.
      if (!sibling || sibling.enrolledAt !== null || sibling.enrollmentCodeUsedAt !== null || sibling.revokedAt !== null) return false;
      if (sibling.enrollmentCodeHash !== enrollmentCodeHash) return false;
      local.set(envId, { ...sibling, machinePublicKey, machineKeyFingerprint, serverKeyId, ownerCredentials, enrolledAt: at, enrollmentCodeUsedAt: at, enrollmentCodeHash: null, updatedAt: at });
      return true;
    },

    async reissueEnrollmentCode({ envId, enrollmentCodeHash, enrollmentCodeExpiresAt, now: at }) {
      const sibling = local.get(envId);
      // The real store's CAS: only a pending, unrevoked row gets a new code.
      if (!sibling || sibling.enrolledAt !== null || sibling.revokedAt !== null) return false;
      local.set(envId, { ...sibling, enrollmentCodeHash, enrollmentCodeExpiresAt, enrollmentCodeUsedAt: null, updatedAt: at });
      return true;
    },

    async setChallenge({ envId, nonce, expiresAt, now: at }) {
      const sibling = local.get(envId);
      if (!sibling || sibling.enrolledAt === null || sibling.revokedAt !== null) return false;
      // The real store's C5 predicate: a live, unconsumed nonce is never replaced.
      const live = sibling.challengeNonce !== null && sibling.challengeUsedAt === null && sibling.challengeExpiresAt !== null && sibling.challengeExpiresAt.getTime() > at.getTime();
      if (live) return false;
      local.set(envId, { ...sibling, challengeNonce: nonce, challengeIssuedAt: at, challengeExpiresAt: expiresAt, challengeUsedAt: null, updatedAt: at });
      return true;
    },

    async consumeChallenge({ envId, nonce, now: at }) {
      const sibling = local.get(envId);
      // CAS on the exact nonce and its unconsumed state; consuming is also a
      // heartbeat (the machine just proved it is alive).
      if (!sibling || sibling.challengeNonce !== nonce || sibling.challengeUsedAt !== null || sibling.revokedAt !== null) return false;
      local.set(envId, { ...sibling, challengeUsedAt: at, lastSeenAt: at, updatedAt: at });
      return true;
    },

    async recordHello({ envId, capabilities, daemonEpoch, now: at }) {
      const sibling = local.get(envId);
      if (!sibling || sibling.enrolledAt === null || sibling.revokedAt !== null) return false;
      local.set(envId, { ...sibling, capabilities, daemonEpoch, lastSeenAt: at, updatedAt: at });
      return true;
    },

    async recordHeartbeat({ envId, now: at }) {
      const sibling = local.get(envId);
      if (!sibling || sibling.enrolledAt === null || sibling.revokedAt !== null) return false;
      local.set(envId, { ...sibling, lastSeenAt: at, updatedAt: at });
      return true;
    },

    async revokeLocal({ envId, now: at }) {
      const sibling = local.get(envId);
      // CAS on `revokedAt IS NULL`: a second revoke is an answer (false), not a rewrite of the stamp.
      if (!sibling || sibling.revokedAt !== null) return false;
      local.set(envId, { ...sibling, revokedAt: at, updatedAt: at });
      return true;
    },

    async setPaused({ envId, ownerId, paused, now: at }) {
      const sibling = local.get(envId);
      // The real store's CAS predicate, verbatim: owner AND not revoked; Stop keeps the first stamp.
      if (!sibling || sibling.ownerId !== ownerId || sibling.revokedAt !== null) return false;
      if (paused && sibling.pausedAt !== null) return true;
      local.set(envId, { ...sibling, pausedAt: paused ? at : null, updatedAt: at });
      return true;
    },

    async listSpriteEnvsInUserDrives(userId) {
      // The real store's predicate, modelled: Sprite substrate, in a drive the
      // user owns or has ACCEPTED membership of. The fake has no membership
      // table, so `driveMemberships` is the seam the tests drive it through.
      return [...rows.values()].filter(
        (row) => row.substrate === 'sprite' && (driveMemberships.get(userId)?.has(row.driveId) ?? false),
      );
    },

    async listVisibleToGlobalAssistantByOwner(ownerId) {
      // The real store's predicate, verbatim: the caller OWNS the machine, it
      // is not revoked, AND the env is visible to the global assistant.
      const out: Array<{ env: DriveEnvRecord; local: DriveEnvLocalRecord }> = [];
      for (const sibling of local.values()) {
        const row = rows.get(sibling.envId);
        if (!row) continue;
        if (sibling.ownerId !== ownerId || sibling.revokedAt !== null || !row.visibleToGlobalAssistant) continue;
        out.push({ env: row, local: sibling });
      }
      return out;
    },

    async setGlobalAssistantVisibility({ envId, ownerId, visible, now: at }) {
      // The real store's CAS predicate, verbatim: the env exists, the SIBLING's
      // owner is the caller, and it is not revoked. The column lives on the env
      // row; the owner lives on the sibling.
      const row = rows.get(envId);
      const sibling = local.get(envId);
      if (!row || !sibling || sibling.ownerId !== ownerId || sibling.revokedAt !== null) return false;
      rows.set(envId, { ...row, visibleToGlobalAssistant: visible, updatedAt: at });
      return true;
    },

    async setServerPolicy({ envId, ownerId, serverPolicy, now: at }) {
      const sibling = local.get(envId);
      // The real store's CAS predicate, verbatim: owner AND not revoked.
      if (!sibling || sibling.ownerId !== ownerId || sibling.revokedAt !== null) return false;
      local.set(envId, { ...sibling, serverPolicy: { ops: [...serverPolicy.ops], checkpoint: serverPolicy.checkpoint }, updatedAt: at });
      return true;
    },

    async rename({ envId, name, now: at }) {
      const row = rows.get(envId);
      if (!row) return { ok: false, reason: 'not_found' };
      if (nameTaken(row.driveId, name, envId)) return { ok: false, reason: 'name_taken' };
      const next = { ...row, name, updatedAt: at };
      rows.set(envId, next);
      return { ok: true, env: next };
    },

    async deleteIfUnoccupied({ envId, force }) {
      calls.deleteIfUnoccupied += 1;
      const row = rows.get(envId);
      if (!row) return { ok: false, reason: 'not_found' };
      // The guard re-read INSIDE the atomic step — the fake is single-threaded,
      // so what this models is the ordering: the count that DECIDES is taken
      // here, under the notional row lock, not from the caller's earlier
      // unlocked snapshot.
      if (!force) {
        const liveSessionCount = liveSessions.get(envId) ?? 0;
        if (liveSessionCount > 0) return { ok: false, reason: 'live_sessions', liveSessionCount };
      }
      rows.delete(envId);
      // The AFTER DELETE trigger, WHEN clause included: it fires only for a
      // row that still BELIEVES it holds a live Sprite (`sandboxId IS NOT NULL
      // AND spriteTornDownAt IS NULL` — the same predicate as the partial index
      // and the orphan reconciler). A confirmed-dead Sprite enqueues nothing;
      // a row for a dead name would have the cron chase it forever.
      if (row.sandboxId !== null && row.spriteTornDownAt === null) {
        reclaims.set(row.sandboxId, row.spriteInstanceId);
      }
      return { ok: true };
    },

    async countLiveSessionsInEnv(envId) {
      return liveSessions.get(envId) ?? 0;
    },

    async countEnvsOwnedBy(payerId) {
      return ownedEnvs.get(payerId) ?? 0;
    },

    async updateSpriteIdentity({ envId, previousSandboxId, spriteKey, sandboxId, spriteInstanceId, egressPolicyToken, stamps, now: at }) {
      const row = rows.get(envId);
      if (!row) return false;
      // The identity CAS: only the provisioner whose read matches the row's
      // CURRENT pointer may record an identity.
      if ((row.sandboxId ?? null) !== (previousSandboxId ?? null)) return false;
      rows.set(envId, {
        ...row,
        spriteKey,
        sandboxId,
        spriteInstanceId,
        egressPolicyToken,
        // MONOTONIC, mirroring the real store's `GREATEST(column, <now>)`. The
        // provision's timestamp is captured before the provider IO, so it can be
        // older than a watermark a reconcile tick has already advanced — assigning
        // it would drag the watermark back over billed time. A fake that assigned
        // would let that guard be deleted with every fake-backed test still green.
        storageLastBilledAt:
          row.storageLastBilledAt > at ? row.storageLastBilledAt : at,
        updatedAt: at,
        ...envStampColumns(stamps),
      });
      return true;
    },

    async applyStamps({ envId, stamps, cas }) {
      const row = rows.get(envId);
      const columns = envStampColumns(stamps);
      if (Object.keys(columns).length === 0) return true;
      if (!row) return cas?.sandboxId === undefined;
      if (cas?.sandboxId !== undefined && (row.sandboxId ?? null) !== (cas.sandboxId ?? null)) return false;
      rows.set(envId, { ...row, ...columns, updatedAt: now() });
      return true;
    },

    async recordStorageMeasurement({ envId, spriteInstanceId, measuredBytes, measuredAt }) {
      const row = rows.get(envId);
      if (!row) return false;
      // Both real guards, modelled: never write to a torn-down row, and CAS on
      // the INSTANCE measured so a late measurement cannot land on the
      // replacement generation's disk. A miss is an ANSWER (`false`), never a throw.
      if (row.spriteTornDownAt !== null) return false;
      if ((row.spriteInstanceId ?? null) !== (spriteInstanceId ?? null)) return false;
      rows.set(envId, { ...row, storageMeasuredBytes: measuredBytes, storageMeasuredAt: measuredAt });
      return true;
    },

    async requestTeardown({ envId, sandboxId, spriteInstanceId, at }) {
      calls.requestTeardown += 1;
      const row = rows.get(envId);
      if (!row) return;
      if (row.sandboxId !== sandboxId) return;
      if ((row.spriteInstanceId ?? null) !== (spriteInstanceId ?? null)) return;
      rows.set(envId, { ...row, teardownRequestedAt: at, updatedAt: at });
    },

    async stampSpriteTornDown({ envId, sandboxId, spriteInstanceId, stamps }) {
      calls.stampSpriteTornDown += 1;
      const row = rows.get(envId);
      if (!row) return false;
      // CAS on the INSTANCE, not just the name — a concurrent re-provision's
      // live replacement must never be stamped dead.
      if (row.sandboxId !== sandboxId) return false;
      if ((row.spriteInstanceId ?? null) !== (spriteInstanceId ?? null)) return false;
      rows.set(envId, { ...row, ...envStampColumns(stamps), updatedAt: now() });
      return true;
    },

    async reloadSpritePointer(envId) {
      const row = rows.get(envId);
      if (!row) return null;
      return { sandboxId: row.sandboxId, spriteInstanceId: row.spriteInstanceId };
    },

    async enqueueReclaim({ sandboxId, spriteInstanceId }) {
      reclaims.set(sandboxId, spriteInstanceId ?? reclaims.get(sandboxId) ?? null);
    },
  };

  return { store, rows, local, reclaims, liveSessions, ownedEnvs, calls };
}
