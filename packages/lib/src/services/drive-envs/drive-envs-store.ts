/**
 * Drive environments store (IO, dependency-injected).
 *
 * DB-backed CRUD for `drive_envs` — one row per persistent, drive-owned
 * environment — plus the Sprite-identity slice the holder-neutral provisioner
 * (`ensureSpriteHolderSandbox`) requires of any Sprite holder. Split from the
 * orchestration in `drive-envs.ts` for the reason `agent-workspaces-store.ts`
 * gives: orchestration is testable against an in-memory fake with no database
 * and no live Sprite.
 *
 * Two things this module deliberately does NOT do:
 *
 *  - **No policy.** Every lifecycle write here is described by a verdict
 *    computed elsewhere (`planSpriteHolderLifecycle`, `planEnvDelete`),
 *    including WHICH columns to stamp — they arrive as a
 *    `SpriteHolderRowStamps` object rather than being re-derived per call site.
 *  - **No session writes.** An env owns its sessions through a cascading FK, not
 *    through this store: it COUNTS live sessions (the delete guard's input) and
 *    never ends, binds, or deletes one. Deleting the env row is what removes
 *    them, in the database, atomically with the row that owned them.
 *
 * **The Sprite slice mirrors `AgentSessionStore`'s method-for-method**, under
 * `envId` instead of `workspaceId`, because that is what makes an env a second
 * HOLDER rather than a second provisioner: `drive-envs.ts` adapts the names and
 * hands this slice to the one provisioning core, so the CAS that serializes
 * concurrent provisions is the same code for both holder kinds. See
 * `agent-workspace-sprite.ts` for why a second copy of that CAS would be
 * correct against itself and race against nothing.
 *
 * Every read is BOUNDED (`.limit(...)`, or an aggregate `count()`): an env
 * listing is small by construction — quota caps them per payer — but the
 * findMany-limit rule exists because "small by construction" is a claim about
 * today's constants, not about the query.
 */

import type { SpriteHolderRowStamps } from '../../agent-workspaces/plan-workspace-lifecycle';
import { MAX_DRIVE_ENVS_LISTED } from '../../drive-envs/env-contract';

/**
 * One `drive_envs` row.
 *
 * Mirrors the table column-for-column on purpose: `findById` selects the WHOLE
 * row and casts it to this interface, so a column missing from this mirror is
 * not absent at runtime — it is present and invisible to the type system, which
 * is the drift the session store's own record type warns about.
 */
export interface DriveEnvRecord {
  /** The env's own id — the API address and the Sprite-key fold. */
  id: string;
  /** The owning drive. NOT NULL: an env has no user-scoped form. */
  driveId: string;
  /** Unique within the drive — an address, not a label. */
  name: string;
  /** AUDIT ONLY: who asked for this env. Nothing resolves payment, permission or lifecycle through it. */
  createdBy: string | null;

  spriteKey: string | null;
  sandboxId: string | null;
  spriteInstanceId: string | null;
  egressPolicyToken: string | null;
  teardownRequestedAt: Date | null;
  spriteTornDownAt: Date | null;

  storageLastBilledAt: Date;
  storageMeasuredBytes: number | null;
  storageMeasuredAt: Date | null;

  lastActiveAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewDriveEnvInput {
  driveId: string;
  name: string;
  /** The creating user, recorded for audit. Null when no user context applies. */
  createdBy: string | null;
  now: Date;
}

export interface DriveEnvStore {
  findById(envId: string): Promise<DriveEnvRecord | null>;
  /**
   * The drive's environments, oldest first, bounded by
   * {@link MAX_DRIVE_ENVS_LISTED}. Oldest-first rather than
   * newest-activity-first (the session listing's order): env names are
   * addresses a user learns the position of, so a listing that reshuffled as
   * machines woke would move the row someone was reaching for.
   */
  list(driveId: string): Promise<DriveEnvRecord[]>;
  /**
   * Mint an env row. NOT idempotent: creating an env is an explicit act.
   *
   * `(driveId, name)` is UNIQUE, so a duplicate name is refused BY THE DATABASE
   * and reported as `name_taken` rather than raised — a name collision is an
   * ordinary answer to an ordinary request (two admins naming a `staging` at
   * once), not an exception the caller should have to pattern-match a driver
   * error string to recognize.
   */
  create(input: NewDriveEnvInput): Promise<{ ok: true; env: DriveEnvRecord } | { ok: false; reason: 'name_taken' }>;
  /**
   * Rename, subject to the same unique constraint — and reporting the same
   * `name_taken` answer for the same reason. `not_found` distinguishes a
   * vanished env from a refused one, which the caller needs to choose 404 vs 409.
   */
  rename(input: {
    envId: string;
    name: string;
    now: Date;
  }): Promise<{ ok: true; env: DriveEnvRecord } | { ok: false; reason: 'name_taken' | 'not_found' }>;
  /**
   * Delete the row. The cascade removes every session bound to it (and, through
   * those sessions, their panes, rev counters and shells), and the AFTER DELETE
   * trigger rescues this row's Sprite pointer into `machine_sprite_reclaims` —
   * the crash net for a teardown that never confirmed.
   *
   * Reports whether a row was actually removed, so a concurrent delete of the
   * same env is answered honestly rather than reported twice as a success.
   */
  deleteById(envId: string): Promise<boolean>;
  /**
   * Sessions still LIVE inside this env — rows carrying this `envId` with no
   * `endedAt`. The delete guard's input. A COUNT, never `list(...).length`: the
   * question is how many, and a guard should not pull every column of every
   * session to answer it.
   */
  countLiveSessionsInEnv(envId: string): Promise<number>;
  /**
   * How many envs this PAYER already owns, across every drive they own — the
   * quota's input.
   *
   * Counted through drive ownership, not through `createdBy`: an env is
   * DRIVE-owned and drive-billed, `createdBy` is audit only, and metering the
   * creator would let a payer hold unlimited envs by having members create them
   * (and would bill a member who has since left for machines they cannot see).
   */
  countEnvsOwnedBy(payerId: string): Promise<number>;

  // ---------------------------------------------------------------------------
  // The Sprite-holder slice. Method-for-method the same contract as
  // `AgentSessionStore`'s identically-named methods — see that module for the CAS
  // semantics each one owes. `drive-envs.ts` adapts `envId` → `holderId` and
  // hands these to `ensureSpriteHolderSandbox`.
  // ---------------------------------------------------------------------------

  /**
   * Record a freshly-provisioned (or adopted) Sprite identity under a CAS on the
   * row's CURRENT `sandboxId`, together with the verdict's stamps — ONE atomic
   * write, so a row can never be seen carrying a new identity with the previous
   * generation's teardown stamps still on it.
   */
  updateSpriteIdentity(input: {
    envId: string;
    previousSandboxId: string | null;
    spriteKey: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    egressPolicyToken: string | null;
    stamps: SpriteHolderRowStamps;
    now: Date;
  }): Promise<boolean>;
  /**
   * Write a verdict's stamps, optionally CAS-guarded on the pointer the plan was
   * computed from. `cas.endedAt` is accepted for signature parity with the
   * session store — an env row HAS no `endedAt` column (an env is persistent;
   * it is deleted, never ended), so the guard is ignored rather than silently
   * matched against something else.
   */
  applyStamps(input: {
    envId: string;
    stamps: SpriteHolderRowStamps;
    cas?: { sandboxId?: string | null; endedAt?: Date | null };
  }): Promise<boolean>;
  /**
   * Record the durable teardown INTENT, BEFORE the kill — the one stamp written
   * ahead of its IO, so a crash between "we decided to kill" and "the kill was
   * confirmed" still leaves the Sprite reclaimable. CAS-guarded on the pointer
   * about to be killed: a concurrent provision that revived this env onto a NEW
   * VM must not be left carrying a teardown request, because a teardown request
   * is exactly what licenses the orphan reconciler to destroy a Sprite.
   */
  requestTeardown(input: {
    envId: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    at: Date;
  }): Promise<void>;
  /**
   * Stamp the row after its Sprite is CONFIRMED killed, under a CAS on the
   * INSTANCE. Keeps the row — an env survives its machine — and the CAS is what
   * stops a concurrent re-provision's LIVE replacement from being marked dead.
   */
  stampSpriteTornDown(input: {
    envId: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    stamps: SpriteHolderRowStamps;
  }): Promise<boolean>;
  /** Re-read just the Sprite pointer AND INSTANCE, to reconcile a lost provisioning race BEFORE killing. */
  reloadSpritePointer(envId: string): Promise<{ sandboxId: string | null; spriteInstanceId: string | null } | null>;
  /**
   * Enqueue a Sprite pointer into the reclaim outbox (`machine_sprite_reclaims`)
   * — for a Sprite that was PROVISIONED but never recorded on any row, which no
   * trigger and no row-based cross-check could ever find. Idempotent, mirroring
   * the trigger's own insert.
   */
  enqueueReclaim(input: { sandboxId: string; spriteInstanceId: string | null }): Promise<void>;
}

/**
 * Translate a lifecycle verdict's stamps into env columns to write (pure).
 *
 * The session store's `stampColumns` twin, minus `endedAt`: `drive_envs` has no
 * such column, and silently dropping a key a caller passed would be worse than
 * not accepting it — so the ENV type simply cannot express it, and the one
 * verdict that stamps `endedAt` (a session `end`) is not a verdict any env path
 * executes.
 *
 * The encoding this preserves, exactly as the session twin does: an ABSENT key
 * means "leave this column alone", an explicit `null` means "clear it". A spread
 * would collapse that distinction the moment a stamps object carried an explicit
 * `undefined`.
 */
export function envStampColumns(stamps: SpriteHolderRowStamps): Partial<{
  lastActiveAt: Date;
  teardownRequestedAt: Date | null;
  spriteTornDownAt: Date | null;
  storageMeasuredBytes: null;
  storageMeasuredAt: null;
}> {
  const columns: Record<string, unknown> = {};
  if (stamps.lastActiveAt !== undefined) columns.lastActiveAt = stamps.lastActiveAt;
  if (stamps.teardownRequestedAt !== undefined) columns.teardownRequestedAt = stamps.teardownRequestedAt;
  if (stamps.spriteTornDownAt !== undefined) columns.spriteTornDownAt = stamps.spriteTornDownAt;
  if (stamps.storageMeasuredBytes !== undefined) columns.storageMeasuredBytes = stamps.storageMeasuredBytes;
  if (stamps.storageMeasuredAt !== undefined) columns.storageMeasuredAt = stamps.storageMeasuredAt;
  return columns;
}

/**
 * What recording a live (re-)provisioned Sprite writes onto a `drive_envs` row
 * (pure) — the env twin of `revivedAgentSessionColumns`.
 *
 * The identity, the verdict's stamps, and a RESET storage watermark. The reset
 * is not a stamp because it is not a lifecycle fact: a new Sprite generation is
 * a fresh, empty filesystem, so billing the elapsed window against the dead
 * generation's measured size would charge for a disk that no longer exists.
 */
export function revivedDriveEnvColumns(input: {
  spriteKey: string;
  sandboxId: string;
  spriteInstanceId: string | null;
  egressPolicyToken: string | null;
  stamps: SpriteHolderRowStamps;
  now: Date;
}) {
  return {
    spriteKey: input.spriteKey,
    sandboxId: input.sandboxId,
    spriteInstanceId: input.spriteInstanceId,
    egressPolicyToken: input.egressPolicyToken,
    storageLastBilledAt: input.now,
    updatedAt: input.now,
    ...envStampColumns(input.stamps),
  };
}

/** Postgres unique-violation. A duplicate `(driveId, name)` is an ANSWER (`name_taken`), never a raised error. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * tables and operators so callers that inject a fake (in tests) never load the
 * DB module graph — the same shape `createDbAgentSessionStore` uses.
 *
 * `now` defaults to the wall clock and is injectable for the store's own
 * bookkeeping touches (an `updatedAt` bump alongside a verdict that names no
 * timestamp of its own), so a test can pin it rather than assert "some recent
 * timestamp".
 */
export async function createDbDriveEnvStore(now: () => Date = () => new Date()): Promise<DriveEnvStore> {
  const [
    { db },
    { eq, and, eqOrIsNull, isNull, sql, count, asc },
    { driveEnvs },
    { agentWorkspaces },
    { drives },
    { machineSpriteReclaims },
  ] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/drive-envs'),
    import('@pagespace/db/schema/agent-workspaces'),
    import('@pagespace/db/schema/core'),
    import('@pagespace/db/schema/machine-sprite-reclaims'),
  ]);

  return {
    async findById(envId) {
      const [row] = await db.select().from(driveEnvs).where(eq(driveEnvs.id, envId)).limit(1);
      return (row as DriveEnvRecord) ?? null;
    },

    async list(driveId) {
      const rows = await db
        .select()
        .from(driveEnvs)
        .where(eq(driveEnvs.driveId, driveId))
        .orderBy(asc(driveEnvs.createdAt))
        .limit(MAX_DRIVE_ENVS_LISTED);
      return rows as DriveEnvRecord[];
    },

    async create({ driveId, name, createdBy, now: at }) {
      try {
        const [row] = await db
          .insert(driveEnvs)
          .values({ driveId, name, createdBy, createdAt: at, updatedAt: at })
          .returning();
        return { ok: true as const, env: row as DriveEnvRecord };
      } catch (error) {
        // The unique index IS the concurrency control here: two admins naming a
        // `staging` at once both reach this insert, and exactly one loses.
        if (isUniqueViolation(error)) return { ok: false as const, reason: 'name_taken' as const };
        throw error;
      }
    },

    async rename({ envId, name, now: at }) {
      try {
        const [row] = await db
          .update(driveEnvs)
          .set({ name, updatedAt: at })
          .where(eq(driveEnvs.id, envId))
          .returning();
        if (!row) return { ok: false as const, reason: 'not_found' as const };
        return { ok: true as const, env: row as DriveEnvRecord };
      } catch (error) {
        if (isUniqueViolation(error)) return { ok: false as const, reason: 'name_taken' as const };
        throw error;
      }
    },

    async deleteById(envId) {
      const deleted = await db.delete(driveEnvs).where(eq(driveEnvs.id, envId)).returning({ id: driveEnvs.id });
      return deleted.length > 0;
    },

    async countLiveSessionsInEnv(envId) {
      const [row] = await db
        .select({ n: count() })
        .from(agentWorkspaces)
        .where(and(eq(agentWorkspaces.envId, envId), isNull(agentWorkspaces.endedAt)));
      return row?.n ?? 0;
    },

    async countEnvsOwnedBy(payerId) {
      // Through drive ownership — see the interface doc for why `createdBy`
      // would be the wrong column to meter.
      const [row] = await db
        .select({ n: count() })
        .from(driveEnvs)
        .innerJoin(drives, eq(drives.id, driveEnvs.driveId))
        .where(eq(drives.ownerId, payerId));
      return row?.n ?? 0;
    },

    async updateSpriteIdentity({
      envId,
      previousSandboxId,
      spriteKey,
      sandboxId,
      spriteInstanceId,
      egressPolicyToken,
      stamps,
      now: at,
    }) {
      const updated = await db
        .update(driveEnvs)
        .set(revivedDriveEnvColumns({ spriteKey, sandboxId, spriteInstanceId, egressPolicyToken, stamps, now: at }))
        .where(
          and(
            eq(driveEnvs.id, envId),
            // CAS on the CURRENT sandboxId: null for a first provision, the
            // vanished/replaced name for a re-provision. `eqOrIsNull` matches
            // the null case, which plain `eq` never does in SQL.
            eqOrIsNull(driveEnvs.sandboxId, previousSandboxId),
          ),
        )
        .returning({ id: driveEnvs.id });
      return updated.length > 0;
    },

    async applyStamps({ envId, stamps, cas }) {
      const columns = envStampColumns(stamps);
      // Nothing to write is a legitimate verdict; an empty `set` is a SQL error.
      if (Object.keys(columns).length === 0) return true;
      const conditions = [eq(driveEnvs.id, envId)];
      // Only `sandboxId` is a real guard here: `drive_envs` has no `endedAt`
      // column (see the interface doc), so `cas.endedAt` is accepted for
      // signature parity and deliberately not translated into a condition.
      if (cas?.sandboxId !== undefined) conditions.push(eqOrIsNull(driveEnvs.sandboxId, cas.sandboxId));
      const updated = await db
        .update(driveEnvs)
        .set({ ...columns, updatedAt: now() })
        .where(and(...conditions))
        .returning({ id: driveEnvs.id });
      // No guard requested: the caller accepted whatever the row currently is,
      // so a miss (the row was deleted) is not a refusal.
      if (cas?.sandboxId === undefined) return true;
      return updated.length > 0;
    },

    async requestTeardown({ envId, sandboxId, spriteInstanceId, at }) {
      await db
        .update(driveEnvs)
        .set({ teardownRequestedAt: at, updatedAt: at })
        .where(
          and(
            eq(driveEnvs.id, envId),
            eq(driveEnvs.sandboxId, sandboxId),
            eqOrIsNull(driveEnvs.spriteInstanceId, spriteInstanceId),
          ),
        );
    },

    async stampSpriteTornDown({ envId, sandboxId, spriteInstanceId, stamps }) {
      const updated = await db
        .update(driveEnvs)
        .set({ ...envStampColumns(stamps), updatedAt: now() })
        // CAS on the INSTANCE, not just the name: a concurrent re-provision may
        // have written a LIVE replacement into this row, and stamping that as
        // torn down would hide a billing VM from the reconciler forever.
        .where(
          and(
            eq(driveEnvs.id, envId),
            eq(driveEnvs.sandboxId, sandboxId),
            eqOrIsNull(driveEnvs.spriteInstanceId, spriteInstanceId),
          ),
        )
        .returning({ id: driveEnvs.id });
      return updated.length > 0;
    },

    async reloadSpritePointer(envId) {
      const [row] = await db
        .select({ sandboxId: driveEnvs.sandboxId, spriteInstanceId: driveEnvs.spriteInstanceId })
        .from(driveEnvs)
        .where(eq(driveEnvs.id, envId))
        .limit(1);
      return row ?? null;
    },

    async enqueueReclaim({ sandboxId, spriteInstanceId }) {
      // Mirrors the AFTER-DELETE trigger's own insert: idempotent on the
      // sandboxId PK, chasing the NEWEST instance on conflict — a newer
      // generation took this deterministic name, so the outbox pointer must
      // follow the VM that is actually alive now.
      await db
        .insert(machineSpriteReclaims)
        .values({ sandboxId, spriteInstanceId })
        .onConflictDoUpdate({
          target: machineSpriteReclaims.sandboxId,
          set: { spriteInstanceId: sql`coalesce(excluded."spriteInstanceId", ${machineSpriteReclaims.spriteInstanceId})` },
        });
    },
  };
}
