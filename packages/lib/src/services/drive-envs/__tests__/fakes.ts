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

import type { DriveEnvRecord, DriveEnvStore } from '../drive-envs-store';
import { envStampColumns } from '../drive-envs-store';

export { makeSpriteHost } from '../../agent-workspaces/__tests__/fakes';

export const NOW = new Date('2026-08-17T12:00:00.000Z');
export const ENV_ID = 'env-1';
export const DRIVE_ID = 'drive-1';
export const PAYER_ID = 'owner-1';

export function makeEnvRecord(over: Partial<DriveEnvRecord> = {}): DriveEnvRecord {
  return {
    id: ENV_ID,
    driveId: DRIVE_ID,
    name: 'staging',
    createdBy: 'user-1',
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

export interface FakeDriveEnvStore {
  store: DriveEnvStore;
  rows: Map<string, DriveEnvRecord>;
  /** Models `machine_sprite_reclaims`: sandboxId → spriteInstanceId. */
  reclaims: Map<string, string | null>;
  /** envId → live (not-ended) session count, the delete guard's input. */
  liveSessions: Map<string, number>;
  /** payerId → envs owned across their drives, the quota's input. */
  ownedEnvs: Map<string, number>;
  calls: { deleteIfUnoccupied: number; requestTeardown: number; stampSpriteTornDown: number };
}

export function makeDriveEnvStore(seed: DriveEnvRecord[] = [], now: () => Date = () => NOW): FakeDriveEnvStore {
  const rows = new Map<string, DriveEnvRecord>();
  for (const row of seed) rows.set(row.id, row);
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

    async createIfUnderLimit({ driveId, name, createdBy, now: at, payerId, maxEnvs }) {
      if (nameTaken(driveId, name)) return { ok: false, reason: 'name_taken' };
      // The structural ceiling, modelled: the fake's map IS the serialized
      // count, so a create past the limit loses here exactly as the advisory
      // -locked count-and-insert makes it lose in Postgres.
      if ((ownedEnvs.get(payerId) ?? 0) >= maxEnvs) return { ok: false, reason: 'limit_reached' };
      minted += 1;
      const row = makeEnvRecord({
        id: `env-${minted}`,
        driveId,
        name,
        createdBy,
        storageLastBilledAt: at,
        createdAt: at,
        updatedAt: at,
      });
      rows.set(row.id, row);
      return { ok: true, env: row };
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
        storageLastBilledAt: at,
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

  return { store, rows, reclaims, liveSessions, ownedEnvs, calls };
}
