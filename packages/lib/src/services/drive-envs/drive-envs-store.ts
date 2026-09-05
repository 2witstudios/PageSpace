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

import type { SQL } from 'drizzle-orm';
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
  /**
   * What runs this env: `'sprite'` (every pre-existing row) or `'local'` (the
   * user's own machine via the bridge). A local row's Sprite columns below are
   * CHECK-forbidden to be non-null — see the `drive_envs` table docblock.
   */
  substrate: 'sprite' | 'local';
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

/**
 * A local env's `drive_env_local` sibling — its LIFECYCLE row: label and owner
 * from creation, the one-time code's hash until enrolled, the pinned machine
 * key from enrollment on, the outstanding challenge nonce per handshake, and
 * the heartbeat / revocation stamps. Never carries a secret the server could
 * replay: the code and the nonce are one-shot, the key is public.
 */
export interface DriveEnvLocalRecord {
  envId: string;
  driveId: string;
  ownerId: string;
  label: string;
  enrollmentId: string;
  machinePublicKey: string | null;
  machineKeyFingerprint: string | null;
  serverKeyId: string | null;
  capabilities: { shell: boolean; pty: boolean; fs: boolean; checkpoint: boolean } | null;
  serverPolicy: { ops: string[]; checkpoint: boolean };
  bindPolicy: string;
  enrollmentCodeHash: string | null;
  enrollmentCodeExpiresAt: Date | null;
  enrollmentCodeUsedAt: Date | null;
  challengeNonce: string | null;
  challengeExpiresAt: Date | null;
  challengeUsedAt: Date | null;
  lastSeenAt: Date | null;
  enrolledAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** The facts a LOCAL create writes to the sibling in the same step as the env row. */
export interface NewDriveEnvLocalFacts {
  ownerId: string;
  label: string;
  enrollmentId: string;
  enrollmentCodeHash: string;
  enrollmentCodeExpiresAt: Date;
}

export interface NewDriveEnvInput {
  driveId: string;
  name: string;
  /** The creating user, recorded for audit. Null when no user context applies. */
  createdBy: string | null;
  now: Date;
  /**
   * Present for a LOCAL env: the row is minted with `substrate = 'local'` and
   * its sibling is inserted in the SAME transaction, so a local env never
   * exists without one. Absent for a Sprite env.
   */
  local?: NewDriveEnvLocalFacts;
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
   * Mint an env row IFF this PAYER is under `maxEnvs` owned environments — the
   * ceiling made STRUCTURAL rather than a pre-check, exactly as
   * `AgentSessionStore.createIfUnderLimit` makes the session spawn ceiling
   * structural.
   *
   * A count-then-insert at the call site is TOCTOU-racy in a way the unique
   * index cannot cover: `(driveId, name)` only serializes creates of the SAME
   * name, so two admins creating `dev` and `staging` for one payer sitting at
   * the ceiling both read "under" and both insert. This serializes the
   * count-and-insert under a per-PAYER Postgres advisory lock (the same
   * primitive the session spawn ceiling and `credit-gate.ts` use), so two
   * concurrent creates billed to one payer cannot both win, while creates for
   * different payers never contend.
   *
   * Per payer, NOT per drive: the ceiling is on what the payer owns across
   * every drive they own, so a per-drive lock would let one payer's two drives
   * race past it — the same hole with more steps.
   *
   * **`payerId` MUST be `driveId`'s owner.** The lock key, the count and the
   * inserted row have to describe one ledger; a `payerId` that does not own
   * this drive would serialize on one payer's key while metering a second
   * payer's envs and inserting into a third's drive. It is a parameter rather
   * than a join inside the transaction only because the caller has already
   * resolved the drive's owner to get their TIER (`resolveDriveEnvPayer`, which
   * fails closed on a vanished drive), so re-reading it here would be a second
   * source of truth for the same fact rather than a check on it.
   *
   * It is also the ONLY way to mint an env row. There is deliberately no
   * unguarded `create` alongside it: a second minting path is a ceiling a
   * future caller can forget, and the whole point of making this structural is
   * that it cannot be forgotten.
   *
   * `(driveId, name)` is UNIQUE, so a duplicate name is refused BY THE DATABASE
   * and reported as `name_taken` rather than raised — a name collision is an
   * ordinary answer to an ordinary request (two admins naming a `staging` at
   * once), not an exception the caller should pattern-match a driver error
   * string to recognize.
   */
  createIfUnderLimit(
    input: NewDriveEnvInput & { payerId: string; maxEnvs: number },
  ): Promise<
    | { ok: true; env: DriveEnvRecord; local: DriveEnvLocalRecord | null }
    | { ok: false; reason: 'name_taken' | 'limit_reached' }
  >;

  // ---------------------------------------------------------------------------
  // The local-env identity slice, over `drive_env_local`. Every write is a
  // compare-and-set on the row's CURRENT state (`UPDATE ... WHERE`), never a
  // read-then-write: two replicas enrolling, or redeeming, the same machine
  // at once must resolve to exactly one winner.
  // ---------------------------------------------------------------------------

  /** The sibling by its wire identity (what the daemon presents). */
  findLocalByEnrollmentId(enrollmentId: string): Promise<DriveEnvLocalRecord | null>;
  /** Every sibling in the drive — what the listing joins. */
  listLocalFacts(driveId: string): Promise<DriveEnvLocalRecord[]>;
  /**
   * Enroll: pin the machine key and consume the code, IFF the row is pending
   * (`enrolledAt IS NULL AND enrollmentCodeUsedAt IS NULL AND revokedAt IS
   * NULL`). Clears the code hash — a consumed code is not kept around.
   */
  pinMachineKey(input: { envId: string; machinePublicKey: string; machineKeyFingerprint: string; serverKeyId: string; now: Date }): Promise<boolean>;
  /** Store the outstanding challenge, replacing any previous one, IFF enrolled and not revoked. */
  setChallenge(input: { envId: string; nonce: string; expiresAt: Date; now: Date }): Promise<boolean>;
  /**
   * Consume the challenge IFF it is exactly this nonce, unconsumed, and the
   * enrollment is not revoked (revocation is part of the CAS so a concurrent
   * revoke wins). Also records `lastSeenAt` — a machine that just proved its
   * key is alive.
   */
  consumeChallenge(input: { envId: string; nonce: string; now: Date }): Promise<boolean>;
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
   * Delete the row, ATOMICALLY with the live-session guard.
   *
   * The cascade removes every session bound to this env (and, through those
   * sessions, their panes, rev counters and shells), which is why the guard
   * cannot be a separate earlier read: between a count that returned zero and
   * an unguarded delete, a session can bind to this env and be cascaded away
   * with work the caller never opted into destroying.
   *
   * So the count and the delete run in ONE transaction that first takes
   * `SELECT ... FOR UPDATE` on the env row, and that lock is what makes the
   * guard sound rather than merely narrower. Inserting an `agent_workspaces`
   * row with this `envId` must take `FOR KEY SHARE` on this same env row to
   * satisfy its foreign key, and `FOR KEY SHARE` conflicts with `FOR UPDATE`.
   * Therefore, once this transaction holds the lock:
   *
   *  - a session insert that already COMMITTED is visible to the count below
   *    (a new statement snapshot under READ COMMITTED), and refuses the delete;
   *  - a session insert still IN FLIGHT is blocked on the FK lock until this
   *    transaction ends — and if the delete lands, that insert's FK check then
   *    fails against a row that no longer exists. A spawn racing the deletion
   *    of its own environment failing is the correct outcome; a spawn silently
   *    succeeding into a doomed env is not.
   *
   * There is no third interleaving: a session cannot appear between the count
   * and the delete without the lock this transaction is holding.
   *
   * **This reasoning assumes READ COMMITTED**, which is Postgres's default and
   * what this deployment runs (nothing sets an isolation level — verified, not
   * assumed). The assumption is load-bearing rather than incidental: it is what
   * makes a blocked statement RE-READ and see the committed session. Under
   * REPEATABLE READ the same block would end in a serialization failure
   * instead, which is safe but a different contract — so raising the pool's
   * isolation level means revisiting this method, not just this comment.
   *
   * `force` skips the count (not the lock), which is the whole meaning of
   * forcing: the caller has been told sessions are live and has said destroy
   * them anyway.
   *
   * Reports the live count on refusal, and distinguishes a vanished row, so a
   * concurrent delete of the same env is answered honestly rather than reported
   * twice as a success.
   */
  deleteIfUnoccupied(input: {
    envId: string;
    force: boolean;
  }): Promise<{ ok: true } | { ok: false; reason: 'not_found' } | { ok: false; reason: 'live_sessions'; liveSessionCount: number }>;
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
   * Persist an opportunistic storage measurement — the WRITE side of what the
   * storage reconcile only ever reads. Without it an env bills the
   * never-measured 0 floor forever while the cron keeps advancing its watermark,
   * silently discarding every interval.
   *
   * Two guards, both the session store's (`recordStorageMeasurement`) verbatim,
   * because a measurement is fire-and-forget and can land after the disk it
   * describes is gone: a torn-down row is never written, and the write CASes on
   * the INSTANCE measured so one generation's bytes can never be persisted
   * against its replacement's id.
   *
   * Returns whether the row was actually written — the one place this diverges
   * from the session store's twin, which returns void. A refused CAS is not an
   * error and must not throw, but for an ENV it is not harmless either: this is
   * the only writer the row has, so a silent miss leaves it never-measured and
   * billing the 0 floor with nothing to retry it. A session's twin can stay void
   * because its bash and git writers correct the same miss on the next real work.
   * `envStorageMeasureSeam` warns on `false`.
   */
  recordStorageMeasurement(input: {
    envId: string;
    /**
     * The instance actually measured. Null when the driver reports none — then
     * the row's own null matches and the CAS degrades to the liveness guard,
     * which is the most any caller can know without a generation id.
     */
    spriteInstanceId: string | null;
    measuredBytes: number;
    measuredAt: Date;
  }): Promise<boolean>;
  /**
   * Record the durable teardown INTENT, BEFORE the kill — the one stamp written
   * ahead of its IO, so a crash between "we decided to kill" and "the kill was
   * confirmed" leaves a durable record of the intent rather than a silent
   * half-teardown. CAS-guarded on the pointer about to be killed: a concurrent
   * provision that revived this env onto a NEW VM must not be left carrying a
   * teardown request — for sessions that stamp is exactly what licenses the
   * orphan reconciler to destroy a Sprite, and `drive_envs` joins that cron's
   * row sources in the follow-up that folds envs into the crons.
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
  /**
   * The watermark to write — an `SQL` EXPRESSION, never a bare `Date`, and the
   * type is the enforcement.
   *
   * The monotonic guarantee lives in the caller's `GREATEST(...)` because only
   * the store has the table and `sql` in scope (this helper stays pure and free
   * of the DB graph). That split is safe only if a caller cannot accidentally
   * pass `now` and silently reopen the double-bill the guard closes — so the
   * parameter refuses one. A future third caller gets a type error, not a
   * production regression with no red test.
   */
  storageLastBilledAt: SQL;
}) {
  return {
    spriteKey: input.spriteKey,
    sandboxId: input.sandboxId,
    spriteInstanceId: input.spriteInstanceId,
    egressPolicyToken: input.egressPolicyToken,
    // MONOTONIC, and supplied by the caller as an SQL expression rather than
    // derived from `now` here.
    // `input.now` is captured in `ensureSpriteHolderSandbox` BEFORE the provider
    // IO, so by the time this write lands it can be tens of seconds stale — and a
    // reconcile tick that charged through a LATER instant may already have
    // advanced this column. Assigning `now` would drag the watermark backwards
    // past what was just billed, and the next tick would re-bill the difference.
    // The store passes a `GREATEST(...)` expression so the reset keeps its purpose
    // (a new generation must not inherit the old one's window) without ever
    // moving the watermark down. The parameter's type refuses a bare `Date`, so
    // this cannot be reopened by a caller that forgets.
    storageLastBilledAt: input.storageLastBilledAt,
    updatedAt: input.now,
    ...envStampColumns(input.stamps),
  };
}

/** Postgres unique-violation. A duplicate `(driveId, name)` is an ANSWER (`name_taken`), never a raised error. */
const UNIQUE_VIOLATION = '23505';

/** Bounded so a driver that ever produced a cyclic `cause` chain cannot hang a request here. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Is this a unique-constraint violation — WRAPPED OR NOT?
 *
 * The chain walk is the whole point. `drizzle-orm@0.45.2`'s pg-core session
 * catches every driver error and rethrows it as `DrizzleQueryError` with the
 * original on `.cause`, so a top-level `error.code === '23505'` test matches
 * NOTHING that comes back from `db.insert(...)`. A duplicate environment name
 * would then escape as an unhandled error and surface as a 500 instead of the
 * 409 the route is written to send — the failure being silent in exactly the
 * case the code claims to handle.
 *
 * Exported so the walk itself is testable against both shapes: the drivers'
 * bare error and drizzle's wrapper. Which one arrives is a fact about a
 * dependency, and dependencies change — a test pinning both is what makes the
 * next drizzle bump visible instead of quietly re-breaking the 409.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current && (current as { code?: unknown }).code === UNIQUE_VIOLATION) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
    { driveEnvLocal },
    { agentWorkspaces },
    { drives },
    { machineSpriteReclaims },
  ] = await Promise.all([
    import('@pagespace/db/db'),
    import('@pagespace/db/operators'),
    import('@pagespace/db/schema/drive-envs'),
    import('@pagespace/db/schema/drive-env-local'),
    import('@pagespace/db/schema/agent-workspaces'),
    import('@pagespace/db/schema/core'),
    import('@pagespace/db/schema/machine-sprite-reclaims'),
  ]);

  /** A sibling row joined with its env's drive (the record carries `driveId` for the listing join). */
  const localSelection = {
    envId: driveEnvLocal.envId,
    driveId: driveEnvs.driveId,
    ownerId: driveEnvLocal.ownerId,
    label: driveEnvLocal.label,
    enrollmentId: driveEnvLocal.enrollmentId,
    machinePublicKey: driveEnvLocal.machinePublicKey,
    machineKeyFingerprint: driveEnvLocal.machineKeyFingerprint,
    serverKeyId: driveEnvLocal.serverKeyId,
    capabilities: driveEnvLocal.capabilities,
    serverPolicy: driveEnvLocal.serverPolicy,
    bindPolicy: driveEnvLocal.bindPolicy,
    enrollmentCodeHash: driveEnvLocal.enrollmentCodeHash,
    enrollmentCodeExpiresAt: driveEnvLocal.enrollmentCodeExpiresAt,
    enrollmentCodeUsedAt: driveEnvLocal.enrollmentCodeUsedAt,
    challengeNonce: driveEnvLocal.challengeNonce,
    challengeExpiresAt: driveEnvLocal.challengeExpiresAt,
    challengeUsedAt: driveEnvLocal.challengeUsedAt,
    lastSeenAt: driveEnvLocal.lastSeenAt,
    enrolledAt: driveEnvLocal.enrolledAt,
    revokedAt: driveEnvLocal.revokedAt,
    createdAt: driveEnvLocal.createdAt,
    updatedAt: driveEnvLocal.updatedAt,
  };

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

    async findLocalByEnrollmentId(enrollmentId) {
      const [row] = await db
        .select(localSelection)
        .from(driveEnvLocal)
        .innerJoin(driveEnvs, eq(driveEnvs.id, driveEnvLocal.envId))
        .where(eq(driveEnvLocal.enrollmentId, enrollmentId))
        .limit(1);
      return (row as DriveEnvLocalRecord | undefined) ?? null;
    },

    async listLocalFacts(driveId) {
      const rows = await db
        .select(localSelection)
        .from(driveEnvLocal)
        .innerJoin(driveEnvs, eq(driveEnvs.id, driveEnvLocal.envId))
        .where(eq(driveEnvs.driveId, driveId))
        .limit(MAX_DRIVE_ENVS_LISTED);
      return rows as DriveEnvLocalRecord[];
    },

    async pinMachineKey({ envId, machinePublicKey, machineKeyFingerprint, serverKeyId, now: at }) {
      const updated = await db
        .update(driveEnvLocal)
        .set({ machinePublicKey, machineKeyFingerprint, serverKeyId, enrolledAt: at, enrollmentCodeUsedAt: at, enrollmentCodeHash: null, updatedAt: at })
        .where(and(eq(driveEnvLocal.envId, envId), isNull(driveEnvLocal.enrolledAt), isNull(driveEnvLocal.enrollmentCodeUsedAt), isNull(driveEnvLocal.revokedAt)))
        .returning({ envId: driveEnvLocal.envId });
      return updated.length === 1;
    },

    async setChallenge({ envId, nonce, expiresAt, now: at }) {
      const updated = await db
        .update(driveEnvLocal)
        .set({ challengeNonce: nonce, challengeExpiresAt: expiresAt, challengeUsedAt: null, updatedAt: at })
        .where(and(eq(driveEnvLocal.envId, envId), sql`${driveEnvLocal.enrolledAt} IS NOT NULL`, isNull(driveEnvLocal.revokedAt)))
        .returning({ envId: driveEnvLocal.envId });
      return updated.length === 1;
    },

    async consumeChallenge({ envId, nonce, now: at }) {
      const updated = await db
        .update(driveEnvLocal)
        .set({ challengeUsedAt: at, lastSeenAt: at, updatedAt: at })
        // `revokedAt IS NULL` is part of the CAS, not just the earlier read:
        // a revocation landing between the service's read and this write must
        // win, or a revoked machine mints one last token.
        .where(and(eq(driveEnvLocal.envId, envId), eq(driveEnvLocal.challengeNonce, nonce), isNull(driveEnvLocal.challengeUsedAt), isNull(driveEnvLocal.revokedAt)))
        .returning({ envId: driveEnvLocal.envId });
      return updated.length === 1;
    },

    async createIfUnderLimit({ driveId, name, createdBy, now: at, payerId, maxEnvs, local }) {
      try {
        return await db.transaction(async (tx) => {
          // Per-payer advisory lock, held for this transaction only — the same
          // primitive the session spawn ceiling uses. It serializes concurrent
          // creates for THIS payer (so the count below cannot go stale before
          // the insert) without contending with any other payer's create.
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'drive-env-create:' + payerId}))`);
          const [{ n }] = await tx
            .select({ n: count() })
            .from(driveEnvs)
            .innerJoin(drives, eq(drives.id, driveEnvs.driveId))
            .where(eq(drives.ownerId, payerId));
          if (n >= maxEnvs) return { ok: false as const, reason: 'limit_reached' as const };
          const [row] = await tx
            .insert(driveEnvs)
            .values({ driveId, name, createdBy, substrate: local ? 'local' : 'sprite', createdAt: at, updatedAt: at })
            .returning();
          if (!local) return { ok: true as const, env: row as DriveEnvRecord, local: null };
          // The sibling in the SAME transaction: a local env never exists
          // without its lifecycle row, and the composite FK holds both ways.
          const [sibling] = await tx
            .insert(driveEnvLocal)
            .values({ envId: row!.id, ownerId: local.ownerId, label: local.label, enrollmentId: local.enrollmentId, enrollmentCodeHash: local.enrollmentCodeHash, enrollmentCodeExpiresAt: local.enrollmentCodeExpiresAt, createdAt: at, updatedAt: at })
            .returning();
          return { ok: true as const, env: row as DriveEnvRecord, local: { ...(sibling as Omit<DriveEnvLocalRecord, 'driveId'>), driveId } as DriveEnvLocalRecord };
        });
      } catch (error) {
        // The `(driveId, name)` unique index still resolves same-name races,
        // and it aborts the transaction — so it surfaces here rather than at
        // the insert above.
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

    async deleteIfUnoccupied({ envId, force }) {
      return db.transaction(async (tx) => {
        // The row lock FIRST — see the interface doc for why it, and not the
        // count, is what makes this guard sound.
        const [locked] = await tx
          .select({ id: driveEnvs.id })
          .from(driveEnvs)
          .where(eq(driveEnvs.id, envId))
          .limit(1)
          .for('update');
        if (!locked) return { ok: false as const, reason: 'not_found' as const };

        if (!force) {
          const [live] = await tx
            .select({ n: count() })
            .from(agentWorkspaces)
            .where(and(eq(agentWorkspaces.envId, envId), isNull(agentWorkspaces.endedAt)));
          const liveSessionCount = live?.n ?? 0;
          if (liveSessionCount > 0) {
            return { ok: false as const, reason: 'live_sessions' as const, liveSessionCount };
          }
        }

        await tx.delete(driveEnvs).where(eq(driveEnvs.id, envId));
        return { ok: true as const };
      });
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
        .set(
          revivedDriveEnvColumns({
            spriteKey,
            sandboxId,
            spriteInstanceId,
            egressPolicyToken,
            stamps,
            now: at,
            // The monotonic reset, built HERE because this is where the table and
            // `sql` are in scope — the helper stays pure and free of the DB graph.
            storageLastBilledAt: sql`GREATEST(${driveEnvs.storageLastBilledAt}, ${sql.param(at, driveEnvs.storageLastBilledAt)})`,
          }),
        )
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

    async recordStorageMeasurement({ envId, spriteInstanceId, measuredBytes, measuredAt }) {
      const updated = await db
        .update(driveEnvs)
        .set({ storageMeasuredBytes: measuredBytes, storageMeasuredAt: measuredAt })
        .where(
          and(
            eq(driveEnvs.id, envId),
            isNull(driveEnvs.spriteTornDownAt),
            // CAS on the generation measured. `eqOrIsNull` so a driver that
            // reports no instance id still matches its own null row rather than
            // never persisting — plain `eq` never matches null in SQL.
            eqOrIsNull(driveEnvs.spriteInstanceId, spriteInstanceId),
          ),
        )
        .returning({ id: driveEnvs.id });
      // Reported, not thrown: a refused CAS means the generation moved under a
      // fire-and-forget `du`, which is correct behaviour, not an error. The
      // CALLER decides it is worth a warning — and for an env it is, because
      // nothing else will write this row.
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
