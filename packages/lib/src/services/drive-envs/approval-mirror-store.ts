/**
 * The server's mirror of a local environment's durable approvals — the store
 * over `drive_env_approvals` (GA wave 3, leaf 5). See the table docblock:
 * visibility and revocation only; the machine's file is authoritative for
 * ALLOW and nothing here can send an approval TO a machine (a source-scan
 * test on the account routes pins that).
 *
 * Two writers: the click route (`remember`, when the re-issued grant ran) and
 * the revoke path (`markRevoked` on the owner's decision, `markAcknowledged`
 * on the machine's SIGNED ack). One replay reader: `listUnacknowledgedRevokes`,
 * what the socket route sends again on the daemon's next hello before any
 * grant for that env is signed.
 */
import type { DriveEnvApprovalDTO } from '../../drive-envs/env-contract';

export type MirroredApprovalScope = 'session' | '30d' | 'until_revoked';

export interface DriveEnvApprovalRecord {
  id: string;
  envId: string;
  userId: string | null;
  op: string;
  summary: string;
  scope: MirroredApprovalScope;
  /** A `session` row's daemon process; NULL for durable scopes. */
  daemonEpoch: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeAcknowledgedAt: Date | null;
  revokeRemoved: number | null;
  /** The owner decided, the machine has not signed for it: the approval may still be held there (Codex P1 #4, review round 1). Derived. */
  revokePending: boolean;
}

/** With the env's drive, for the account page (which links each row to its drive settings page). */
export interface DriveEnvApprovalWithEnv extends DriveEnvApprovalRecord {
  driveId: string;
  envName: string;
  envLabel: string;
}

export interface RememberApprovalInput {
  id: string;
  envId: string;
  userId: string;
  op: string;
  summary: string;
  scope: MirroredApprovalScope;
  /** For a `session` scope: the env's current daemon epoch (from its last hello). Ignored for durable scopes. */
  daemonEpoch?: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface ApprovalMirrorStore {
  /** The click ran: mirror what the machine remembered. Idempotent on `id`. */
  remember(input: RememberApprovalInput): Promise<DriveEnvApprovalRecord>;
  /** The owner's (or an admin's) decision, whatever the machine said. Idempotent: the first stamp stays. @returns the row, or null when unknown. */
  markRevoked(input: { id: string; by: string; now: Date }): Promise<DriveEnvApprovalRecord | null>;
  /** The machine's SIGNED ack landed. Only a revoked row takes it. @returns the row, or null when unknown / not revoked. */
  markAcknowledged(input: { id: string; removed: number; now: Date }): Promise<DriveEnvApprovalRecord | null>;
  /** Revokes owed to the machine: `revokedAt` set, `revokeAcknowledgedAt` not — what the hello replays. */
  listUnacknowledgedRevokes(envId: string): Promise<DriveEnvApprovalRecord[]>;
  /** In force as the machine sees it (not acknowledged-revoked, not expired; revoked-but-unacked rows included and flagged), newest first, bounded. */
  listActiveForEnv(input: { envId: string; now: Date; limit: number }): Promise<DriveEnvApprovalRecord[]>;
  /** In force across every env the user OWNS (never merely requested on), newest first, bounded — the account page. */
  listActiveForOwner(input: { ownerId: string; now: Date; limit: number }): Promise<DriveEnvApprovalWithEnv[]>;
  /** One row, for the revoke path to answer with. */
  findById(id: string): Promise<DriveEnvApprovalRecord | null>;
  /**
   * A hello from daemon process `epoch` (Codex P2 #7): every `session`-scoped
   * row of this env held by a DIFFERENT process is expired now — the machine
   * forgot them when that process exited. Rows of the same epoch (a reconnect
   * without restart) and every durable row are untouched. @returns rows expired.
   */
  expireSessionRowsForOtherEpoch(input: { envId: string; epoch: string; now: Date }): Promise<number>;
}

export const APPROVAL_MIRROR_LIST_LIMIT = 100;
/** Longest `summary` stored — a rendering for a list, not a transcript. */
export const APPROVAL_SUMMARY_MAX_CHARS = 512;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The row as served to the owner: ISO timestamps; the `id` is what a revoke names. */
export function toDriveEnvApprovalDTO(row: DriveEnvApprovalRecord, env?: { driveId: string; envName: string; envLabel: string }): DriveEnvApprovalDTO {
  return {
    id: row.id,
    envId: row.envId,
    driveId: env?.driveId ?? null,
    envName: env?.envName ?? null,
    envLabel: env?.envLabel ?? null,
    userId: row.userId,
    op: row.op,
    summary: row.summary,
    scope: row.scope,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    revokedAt: row.revokedAt === null ? null : row.revokedAt.toISOString(),
    revokeAcknowledgedAt: row.revokeAcknowledgedAt === null ? null : row.revokeAcknowledgedAt.toISOString(),
    revokePending: row.revokePending,
  };
}

/** Production DB-backed implementation; lazy imports so a test with a fake never loads the DB graph. */
export async function createDbApprovalMirrorStore(): Promise<ApprovalMirrorStore> {
  const [{ db }, { eq, ne, and, or, isNull, isNotNull, gt, desc }, { driveEnvApprovals }, { driveEnvLocal }, { driveEnvs }] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/drive-env-approvals'),
    import('@pagespace/db/schema/drive-env-local'),
    import('@pagespace/db/schema/drive-envs'),
  ]);

  const asRecord = (row: typeof driveEnvApprovals.$inferSelect): DriveEnvApprovalRecord => ({
    id: row.id,
    envId: row.envId,
    userId: row.userId,
    op: row.op,
    summary: row.summary,
    scope: row.scope as MirroredApprovalScope,
    daemonEpoch: row.daemonEpoch,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    revokeAcknowledgedAt: row.revokeAcknowledgedAt,
    revokeRemoved: row.revokeRemoved,
    revokePending: row.revokedAt !== null && row.revokeAcknowledgedAt === null,
  });

  // "In force" as the MACHINE sees it (Codex P1 #4, review round 1): a row leaves the listings only once the
  // machine has ACKNOWLEDGED its revoke (or it expired). A revoked-but-unacknowledged row stays, flagged
  // `revokePending` — the list must never say "none in force" while the machine may still hold one.
  const inForce = (now: Date) => and(isNull(driveEnvApprovals.revokeAcknowledgedAt), or(isNull(driveEnvApprovals.expiresAt), gt(driveEnvApprovals.expiresAt, now)));

  return {
    async remember(input) {
      const [row] = await db
        .insert(driveEnvApprovals)
        .values({ id: input.id, envId: input.envId, userId: input.userId, op: input.op, summary: clip(input.summary, APPROVAL_SUMMARY_MAX_CHARS), scope: input.scope, daemonEpoch: input.scope === 'session' ? (input.daemonEpoch ?? null) : null, createdAt: input.createdAt, expiresAt: input.expiresAt })
        .onConflictDoNothing({ target: driveEnvApprovals.id })
        .returning();
      if (row) return asRecord(row);
      const [existing] = await db.select().from(driveEnvApprovals).where(eq(driveEnvApprovals.id, input.id)).limit(1);
      return asRecord(existing!);
    },

    async markRevoked({ id, by, now }) {
      const [row] = await db
        .update(driveEnvApprovals)
        .set({ revokedAt: now, revokedBy: by })
        .where(and(eq(driveEnvApprovals.id, id), isNull(driveEnvApprovals.revokedAt)))
        .returning();
      if (row) return asRecord(row);
      const [existing] = await db.select().from(driveEnvApprovals).where(eq(driveEnvApprovals.id, id)).limit(1);
      return existing ? asRecord(existing) : null;
    },

    async markAcknowledged({ id, removed, now }) {
      const [row] = await db
        .update(driveEnvApprovals)
        .set({ revokeAcknowledgedAt: now, revokeRemoved: removed })
        // Only a revoked, not-yet-acknowledged row takes the ack (the CHECK forbids the other order anyway).
        .where(and(eq(driveEnvApprovals.id, id), isNotNull(driveEnvApprovals.revokedAt), isNull(driveEnvApprovals.revokeAcknowledgedAt)))
        .returning();
      return row ? asRecord(row) : null;
    },

    async listUnacknowledgedRevokes(envId) {
      const rows = await db
        .select()
        .from(driveEnvApprovals)
        .where(and(eq(driveEnvApprovals.envId, envId), isNotNull(driveEnvApprovals.revokedAt), isNull(driveEnvApprovals.revokeAcknowledgedAt)))
        .orderBy(driveEnvApprovals.revokedAt)
        .limit(APPROVAL_MIRROR_LIST_LIMIT);
      return rows.map(asRecord);
    },

    async listActiveForEnv({ envId, now, limit }) {
      const rows = await db
        .select()
        .from(driveEnvApprovals)
        .where(and(eq(driveEnvApprovals.envId, envId), inForce(now)))
        .orderBy(desc(driveEnvApprovals.createdAt))
        .limit(Math.min(limit, APPROVAL_MIRROR_LIST_LIMIT));
      return rows.map(asRecord);
    },

    async listActiveForOwner({ ownerId, now, limit }) {
      const rows = await db
        .select({ approval: driveEnvApprovals, driveId: driveEnvs.driveId, envName: driveEnvs.name, envLabel: driveEnvLocal.label })
        .from(driveEnvApprovals)
        .innerJoin(driveEnvLocal, eq(driveEnvLocal.envId, driveEnvApprovals.envId))
        .innerJoin(driveEnvs, eq(driveEnvs.id, driveEnvApprovals.envId))
        .where(and(eq(driveEnvLocal.ownerId, ownerId), inForce(now)))
        .orderBy(desc(driveEnvApprovals.createdAt))
        .limit(Math.min(limit, APPROVAL_MIRROR_LIST_LIMIT));
      return rows.map((row) => ({ ...asRecord(row.approval), driveId: row.driveId, envName: row.envName, envLabel: row.envLabel }));
    },

    async findById(id) {
      const [row] = await db.select().from(driveEnvApprovals).where(eq(driveEnvApprovals.id, id)).limit(1);
      return row ? asRecord(row) : null;
    },

    async expireSessionRowsForOtherEpoch({ envId, epoch, now }) {
      const rows = await db
        .update(driveEnvApprovals)
        .set({ expiresAt: now })
        // Session rows only; a different (or unknown) epoch; not already expired.
        .where(and(eq(driveEnvApprovals.envId, envId), eq(driveEnvApprovals.scope, 'session'), or(isNull(driveEnvApprovals.daemonEpoch), ne(driveEnvApprovals.daemonEpoch, epoch)), or(isNull(driveEnvApprovals.expiresAt), gt(driveEnvApprovals.expiresAt, now))))
        .returning({ id: driveEnvApprovals.id });
      return rows.length;
    },
  };
}
