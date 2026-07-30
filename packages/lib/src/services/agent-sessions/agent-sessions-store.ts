/**
 * Agent Sessions store (IO, dependency-injected).
 *
 * DB-backed CRUD for `agent_sessions` — one row per SESSION: a drive-level
 * workspace that owns one sandbox and hosts many conversations plus shells
 * (see `contract.ts` invariant 1). Kept separate from the lifecycle orchestration
 * (`agent-sessions.ts`, `agent-session-sprite.ts`) so that orchestration is
 * testable against an in-memory fake with NO database and NO live Sprite, the
 * same discipline `services/machines/agent-terminals-store.ts` established.
 *
 * Two things are deliberately NOT in this module:
 *
 *  - **No policy.** Every write this store performs is described by a verdict
 *    from `plan-session-lifecycle.ts` — including WHICH columns to stamp, which
 *    arrive as an `AgentSessionRowStamps` object rather than being re-derived
 *    per call site. The store's only judgement is how to express "leave this
 *    column alone" versus "clear it" in SQL (see `stampColumns`).
 *  - **No conversation writes.** `conversations.sessionId` is the thread→session
 *    binding, set once at conversation creation by the squat-guarded repository
 *    path. This store READS that binding (`findByConversation` — how a chat
 *    turn resolves its working context) but never writes it: a store that could
 *    bind threads would be a second, unguarded way to move a thread's
 *    filesystem, which the model forbids (moving a thread is a fork).
 */

import type { AgentSessionRowStamps } from '../../agent-sessions/plan-session-lifecycle';

/** One `agent_sessions` row. `id` is the session's OWN identity (see `contract.ts`). */
export interface AgentSessionRecord {
  /** The session's own id — the PK, the Sprite-key fold, the `?session=` URL value. */
  id: string;
  ownerId: string;
  /** null = a global-assistant session (user-scoped, outside any drive). */
  driveId: string | null;
  /** Display label only — no uniqueness, never an address. */
  name: string | null;

  sessionKey: string | null;
  sandboxId: string | null;
  spriteInstanceId: string | null;
  egressPolicyToken: string | null;
  teardownRequestedAt: Date | null;
  spriteTornDownAt: Date | null;

  storageLastBilledAt: Date;
  storageMeasuredBytes: number | null;
  storageMeasuredAt: Date | null;

  lastActiveAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewAgentSessionInput {
  ownerId: string;
  /** null = a global-assistant session. */
  driveId: string | null;
  name: string | null;
  now: Date;
}

/**
 * A list query. At least one narrowing key is required BY TYPE rather than by a
 * runtime guard: an unfiltered enumeration of every session in the deployment is
 * not a query any caller has a use for, and making it unrepresentable is
 * cheaper than remembering to reject it.
 */
export type AgentSessionListFilter =
  | { driveId: string; ownerId?: string }
  | { ownerId: string };

/** The most sessions one listing returns — the sidebar shows the newest slice, not an archive. */
export const SESSION_LIST_LIMIT = 100;

export interface AgentSessionStore {
  findById(sessionId: string): Promise<AgentSessionRecord | null>;
  /**
   * Resolve a conversation's session — how a chat turn finds its working
   * context. Reads `conversations.sessionId` and returns the session row, or
   * null when the thread has no session (a plain chat) or the FK was nulled by
   * a session delete. THE lookup the tool layer folds its Sprite key from:
   * every conversation in one session resolves the same row, which is what
   * makes sandbox sharing structural rather than wired.
   */
  findByConversation(conversationId: string): Promise<AgentSessionRecord | null>;
  /**
   * Create a session row. NOT idempotent and NOT keyed on anything external:
   * a session's id is minted here (schema default), because spawning a session
   * is an explicit act — the old ensure-by-conversation semantics died with
   * the conflation (two first-touches of one conversation used to race to
   * create "its" session; now a conversation is BORN into a session or has
   * none).
   */
  create(input: NewAgentSessionInput): Promise<AgentSessionRecord>;
  /**
   * Mint a session row IFF this owner is under `maxActive` NOT-ENDED sessions
   * — the spawn ceiling made STRUCTURAL rather than a pre-check (review
   * #2261/2). A count-then-insert pre-check at the call site is TOCTOU-racy:
   * N concurrent spawns can all read under the ceiling and all insert. This
   * serializes the count-and-insert under a per-owner Postgres advisory lock
   * (the same primitive `credit-gate.ts`'s billing-off ceiling uses), so two
   * concurrent callers for the SAME owner cannot both win, while spawns for
   * DIFFERENT owners never contend.
   */
  createIfUnderLimit(
    input: NewAgentSessionInput & { maxActive: number },
  ): Promise<{ ok: true; session: AgentSessionRecord } | { ok: false; reason: 'limit_reached' }>;
  /**
   * ACTIVE sessions only (`endedAt IS NULL`), newest activity first
   * (`lastActiveAt DESC NULLS LAST, createdAt DESC`), capped at
   * {@link SESSION_LIST_LIMIT}. Ended rows are retained for lifecycle/billing
   * but are not listings: the sidebar polls this every few seconds, and an
   * unbounded, unordered enumeration that never forgets grew without limit
   * and reshuffled between polls (review M3/M4).
   */
  list(filter: AgentSessionListFilter): Promise<AgentSessionRecord[]>;
  /**
   * Count this owner's ACTIVE (not-ended) sessions — the spawn ceiling's
   * input. Distinct from `countLive`, which counts live SANDBOXES for the
   * concurrency quota: a spawned-but-never-provisioned session is active
   * without being live, and unbounded row minting is what this bounds
   * (review M6/F4).
   */
  countActive(ownerId: string): Promise<number>;
  /**
   * Count this owner's LIVE sessions — `sandboxId IS NOT NULL AND
   * spriteTornDownAt IS NULL` — for the agent-session concurrency quota
   * (Phase 7, `quota.ts`'s `checkAgentSessionConcurrency`). Deliberately a
   * COUNT, not `list(...).length`: a quota check on a hot path should not pull
   * every column of every live row just to learn how many there are.
   */
  countLive(ownerId: string): Promise<number>;
  /**
   * Persist an opportunistic storage measurement (see
   * `services/sandbox/sandbox-storage-measure.ts`). Not a lifecycle transition —
   * a pure billing observation that must never disturb identity or teardown
   * stamps — but it IS generation-scoped, so it carries a CAS of its own.
   *
   * The CAS is on `spriteInstanceId`, the id of the VM actually measured, and it
   * has to be: `sandboxId` is the HMAC-derived NAME, identical across every
   * generation of one session, so it cannot tell A from B. `SandboxHandle` says
   * this outright — "anything that must act on THIS VM (a kill, a CAS against a
   * tracking row) keys on this".
   *
   * A liveness guard alone (`spriteTornDownAt IS NULL`) does NOT cover it. The
   * measurement is fire-and-forget, so a `du` against generation A can still be
   * in flight when A is torn down and B provisioned — and B's own stamps clear
   * `spriteTornDownAt` AND null the measurement columns
   * (`plan-session-lifecycle.ts`), so the late write finds a live row, lands A's
   * bytes on B, and stamps a fresh `storageMeasuredAt` that suppresses B's real
   * measurement for the whole throttle window. The reconcile then bills B's
   * interval against A's disk. The teardown-only guard is the one case where the
   * row is never revived.
   *
   * A stale write is DROPPED, not retried: the next wake re-measures, and a
   * billing observation is worth less than a wrong one.
   */
  recordStorageMeasurement(input: {
    sessionId: string;
    /**
     * The instance actually measured. Null when the driver reports none — then
     * the row's own null matches and the CAS degrades to the liveness guard,
     * which is the most any caller can know without a generation id.
     */
    spriteInstanceId: string | null;
    measuredBytes: number;
    measuredAt: Date;
  }): Promise<void>;
  /**
   * Record a freshly-provisioned (or adopted) Sprite identity onto the row under
   * a compare-and-swap on the CURRENT `sandboxId`, together with the verdict's
   * stamps — ONE atomic write, so a row can never be seen carrying a new
   * identity with the previous generation's teardown stamps still on it.
   *
   * `previousSandboxId` is `null` for a first provision, the vanished/replaced
   * Sprite's name otherwise. Two concurrent provisions of the same unprovisioned
   * session race here; the loser sees `false` and reconciles rather than
   * orphaning its own live VM.
   */
  updateSpriteIdentity(input: {
    sessionId: string;
    previousSandboxId: string | null;
    sessionKey: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    egressPolicyToken: string | null;
    stamps: AgentSessionRowStamps;
    now: Date;
  }): Promise<boolean>;
  /**
   * Write a verdict's stamps — CAS-guarded whenever the verdict was planned
   * from a read that a concurrent identity or lifecycle write could have
   * since invalidated (review #2261/1). Two shapes of guard, matching the two
   * ways a stale plan can corrupt the row:
   *
   *  - `cas.sandboxId` — for a plan computed from a `sandboxId` that could
   *    have been claimed by a concurrent provision in between (the `end`
   *    intent's never-provisioned noop): refuses if the row's CURRENT
   *    `sandboxId` no longer matches, rather than stamping `endedAt` onto a
   *    session a concurrent `ensure` just revived.
   *  - `cas.endedAt` — for an "activity refresh" computed under the
   *    assumption the row was NOT ended (the `resume`/`attach` arm's
   *    `endedAt: null, teardownRequestedAt: null` stamps): refuses if the
   *    row's CURRENT `endedAt` no longer matches, rather than silently
   *    erasing a concurrent `end`'s teardown intent.
   *
   * Absent entirely for verdicts with nothing to race (an already-ended
   * noop's empty stamps). Returns whether the write landed — `true` when no
   * `cas` was given (nothing to have raced) or the CAS matched, `false` when
   * a `cas` was given and refused.
   */
  applyStamps(input: {
    sessionId: string;
    stamps: AgentSessionRowStamps;
    cas?: { sandboxId?: string | null; endedAt?: Date | null };
  }): Promise<boolean>;
  /**
   * Record the durable teardown INTENT, BEFORE the kill. The one stamp written
   * ahead of its IO: its entire job is to survive a crash between "we decided to
   * kill" and "the kill was confirmed", so that the orphan reconciler can finish
   * what this process started.
   *
   * CAS-guarded on the pointer the caller is about to kill, and that guard is
   * load-bearing IN THE OTHER DIRECTION from the rest: if a concurrent ensure has
   * already revived this session onto a NEW VM, an unguarded stamp would leave a
   * LIVE session carrying a teardown request — and a teardown request is exactly
   * what licenses the orphan reconciler to destroy a Sprite.
   */
  requestTeardown(input: {
    sessionId: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    at: Date;
  }): Promise<void>;
  /**
   * Stamp the row after its Sprite is CONFIRMED killed, under a CAS on the
   * INSTANCE. Keeps the row — a killed session is re-provisionable under the
   * same key — and the CAS is what stops a concurrent re-provision's LIVE
   * replacement from being marked dead (which would hide a billing VM from the
   * reconciler forever). Reports whether it stamped.
   */
  stampSpriteTornDown(input: {
    sessionId: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    stamps: AgentSessionRowStamps;
  }): Promise<boolean>;
  /**
   * Re-read just the Sprite pointer AND INSTANCE, to reconcile a lost
   * provisioning race against the winner BEFORE killing. `spriteInstanceId` is
   * load-bearing: a genuine winner recorded OUR generation, whereas a
   * vanished-heal that failed leaves the OLD stale instance behind.
   */
  reloadSpritePointer(sessionId: string): Promise<{ sandboxId: string | null; spriteInstanceId: string | null } | null>;
  /**
   * Enqueue a Sprite pointer into the reclaim outbox (`machine_sprite_reclaims`,
   * kept under its physical name) — for a Sprite that was PROVISIONED but never
   * recorded on any row, so neither the AFTER-DELETE trigger nor a row-based
   * cross-check could ever find it. Idempotent, mirroring the trigger's insert.
   */
  enqueueReclaim(input: { sandboxId: string; spriteInstanceId: string | null }): Promise<void>;
}

/**
 * Translate a lifecycle verdict's stamps into columns to write (pure).
 *
 * The encoding this preserves: an ABSENT key means "leave this column alone",
 * an explicit `null` means "clear it". Spreading the stamps object directly
 * would collapse that distinction the moment a caller built one with an
 * explicit `undefined`, so each key is copied only when present.
 */
export function stampColumns(stamps: AgentSessionRowStamps): Partial<{
  lastActiveAt: Date;
  endedAt: Date | null;
  teardownRequestedAt: Date | null;
  spriteTornDownAt: Date | null;
  storageMeasuredBytes: null;
  storageMeasuredAt: null;
}> {
  const columns: Record<string, unknown> = {};
  if (stamps.lastActiveAt !== undefined) columns.lastActiveAt = stamps.lastActiveAt;
  if (stamps.endedAt !== undefined) columns.endedAt = stamps.endedAt;
  if (stamps.teardownRequestedAt !== undefined) columns.teardownRequestedAt = stamps.teardownRequestedAt;
  if (stamps.spriteTornDownAt !== undefined) columns.spriteTornDownAt = stamps.spriteTornDownAt;
  if (stamps.storageMeasuredBytes !== undefined) columns.storageMeasuredBytes = stamps.storageMeasuredBytes;
  if (stamps.storageMeasuredAt !== undefined) columns.storageMeasuredAt = stamps.storageMeasuredAt;
  return columns;
}

/**
 * What recording a live (re-)provisioned Sprite writes onto an `agent_sessions`
 * row (pure) — the session-tier twin of `revivedAgentTerminalColumns`.
 *
 * The identity, plus the verdict's stamps, plus a RESET storage watermark. The
 * watermark reset is not in the stamps because it is not a lifecycle fact: a new
 * Sprite generation is a fresh, empty filesystem, so billing the elapsed window
 * against the dead generation's measured size would charge for a disk that no
 * longer exists. (The planner clears the MEASUREMENT for the same reason; only
 * the non-nullable watermark has to be advanced rather than cleared.)
 */
export function revivedAgentSessionColumns(input: {
  sessionKey: string;
  sandboxId: string;
  spriteInstanceId: string | null;
  egressPolicyToken: string | null;
  stamps: AgentSessionRowStamps;
  now: Date;
}) {
  return {
    sessionKey: input.sessionKey,
    sandboxId: input.sandboxId,
    spriteInstanceId: input.spriteInstanceId,
    egressPolicyToken: input.egressPolicyToken,
    storageLastBilledAt: input.now,
    updatedAt: input.now,
    ...stampColumns(input.stamps),
  };
}

/**
 * Production DB-backed implementation. Lazily resolves the db client, schema
 * tables and operators so callers that inject a fake (in tests) never load the
 * DB module graph.
 *
 * `now` defaults to the wall clock — every OTHER write in this store takes its
 * timestamp from a caller-supplied `now`, via the lifecycle planner; these two
 * calls are the store's own bookkeeping touch (an `updatedAt` bump alongside a
 * verdict that names no `lastActiveAt` of its own), which is why they were the
 * one place still reaching for `new Date()` directly. Injectable so a test can
 * pin it rather than asserting "some recent timestamp".
 */
export async function createDbAgentSessionStore(now: () => Date = () => new Date()): Promise<AgentSessionStore> {
  const [{ db }, { eq, and, eqOrIsNull, isNotNull, isNull, sql, count, desc }, { agentSessions }, { machineSpriteReclaims }, { conversations }] =
    await Promise.all([
      import('@pagespace/db/db'),
      import('@pagespace/db/operators'),
      import('@pagespace/db/schema/agent-sessions'),
      import('@pagespace/db/schema/machine-sprite-reclaims'),
      import('@pagespace/db/schema/conversations'),
    ]);

  return {
    async findById(sessionId) {
      const [row] = await db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1);
      return (row as AgentSessionRecord) ?? null;
    },

    async findByConversation(conversationId) {
      // conversations.sessionId is the binding; a null FK (plain chat, or a
      // session deleted out from under its history) resolves to null, never to
      // some fallback session — the tool layer's no-session denial depends on
      // that honesty.
      const [row] = await db
        .select({ session: agentSessions })
        .from(conversations)
        .innerJoin(agentSessions, eq(agentSessions.id, conversations.sessionId))
        .where(eq(conversations.id, conversationId))
        .limit(1);
      return (row?.session as AgentSessionRecord) ?? null;
    },

    async create(input) {
      const [row] = await db
        .insert(agentSessions)
        .values({
          ownerId: input.ownerId,
          driveId: input.driveId,
          name: input.name,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      return row as AgentSessionRecord;
    },

    async createIfUnderLimit({ ownerId, driveId, name, now, maxActive }) {
      return db.transaction(async (tx) => {
        // Per-owner advisory lock, held for this transaction only — same
        // primitive `credit-gate.ts`'s billing-off daily ceiling uses.
        // Serializes concurrent spawns for THIS owner (so the count read
        // below cannot go stale before the insert) without contending with
        // any other owner's spawn at all.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'agent-session-spawn:' + ownerId}))`);
        const [{ n }] = await tx
          .select({ n: count() })
          .from(agentSessions)
          .where(and(eq(agentSessions.ownerId, ownerId), isNull(agentSessions.endedAt)));
        if (n >= maxActive) return { ok: false as const, reason: 'limit_reached' as const };
        const [row] = await tx
          .insert(agentSessions)
          .values({ ownerId, driveId, name, createdAt: now, updatedAt: now })
          .returning();
        return { ok: true as const, session: row as AgentSessionRecord };
      });
    },

    async list(filter) {
      const conditions = [];
      if (filter.ownerId !== undefined) conditions.push(eq(agentSessions.ownerId, filter.ownerId));
      if ('driveId' in filter) {
        // driveId is a real column now — a session IS drive-scoped, and a
        // global-assistant session (null driveId) never appears in a
        // drive-scoped listing because NULL never equals the filter.
        conditions.push(eq(agentSessions.driveId, filter.driveId));
      }
      if (conditions.length === 0) {
        // Unreachable through `AgentSessionListFilter`, which requires a
        // narrowing key. Defensive only: an unfiltered enumeration would be a
        // cross-tenant read, so it fails loudly rather than returning it.
        throw new Error('listAgentSessions requires at least one filter');
      }
      conditions.push(isNull(agentSessions.endedAt));
      const rows = await db
        .select()
        .from(agentSessions)
        .where(and(...conditions))
        .orderBy(sql`${agentSessions.lastActiveAt} DESC NULLS LAST`, desc(agentSessions.createdAt))
        .limit(SESSION_LIST_LIMIT);
      return rows as AgentSessionRecord[];
    },

    async countActive(ownerId) {
      const [row] = await db
        .select({ n: count() })
        .from(agentSessions)
        .where(and(eq(agentSessions.ownerId, ownerId), isNull(agentSessions.endedAt)));
      return row?.n ?? 0;
    },

    async countLive(ownerId) {
      const [row] = await db
        .select({ n: count() })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.ownerId, ownerId),
            isNotNull(agentSessions.sandboxId),
            isNull(agentSessions.spriteTornDownAt),
          ),
        );
      return row?.n ?? 0;
    },

    async recordStorageMeasurement({ sessionId, spriteInstanceId, measuredBytes, measuredAt }) {
      await db
        .update(agentSessions)
        .set({ storageMeasuredBytes: measuredBytes, storageMeasuredAt: measuredAt })
        .where(
          and(
            eq(agentSessions.id, sessionId),
            isNull(agentSessions.spriteTornDownAt),
            // CAS on the generation measured. `eqOrIsNull` so a driver that
            // reports no instance id still matches its own null row rather than
            // never persisting — plain `eq` never matches null in SQL.
            eqOrIsNull(agentSessions.spriteInstanceId, spriteInstanceId),
          ),
        );
    },

    async updateSpriteIdentity({
      sessionId,
      previousSandboxId,
      sessionKey,
      sandboxId,
      spriteInstanceId,
      egressPolicyToken,
      stamps,
      now,
    }) {
      const updated = await db
        .update(agentSessions)
        .set(revivedAgentSessionColumns({ sessionKey, sandboxId, spriteInstanceId, egressPolicyToken, stamps, now }))
        .where(
          and(
            eq(agentSessions.id, sessionId),
            // CAS on the CURRENT sandboxId: null for a first provision, the
            // vanished/replaced name for a re-provision. `eqOrIsNull` matches
            // the null case, which plain `eq` never does in SQL.
            eqOrIsNull(agentSessions.sandboxId, previousSandboxId),
          ),
        )
        .returning({ id: agentSessions.id });
      return updated.length > 0;
    },

    async applyStamps({ sessionId, stamps, cas }) {
      const columns = stampColumns(stamps);
      // Nothing to write is a legitimate verdict (a noop that stamps nothing);
      // an empty `set` is a SQL error, so it is skipped rather than special-cased
      // by every caller.
      if (Object.keys(columns).length === 0) return true;
      const conditions = [eq(agentSessions.id, sessionId)];
      if (cas?.sandboxId !== undefined) conditions.push(eqOrIsNull(agentSessions.sandboxId, cas.sandboxId));
      if (cas?.endedAt !== undefined) conditions.push(eqOrIsNull(agentSessions.endedAt, cas.endedAt));
      const updated = await db
        .update(agentSessions)
        .set({ ...columns, updatedAt: now() })
        .where(and(...conditions))
        .returning({ id: agentSessions.id });
      // No guard requested: the caller accepted whatever the row currently is
      // (there was nothing this write could have raced), so a miss (e.g. the
      // row was deleted) is not a refusal — matches the prior unconditional
      // behavior.
      if (!cas) return true;
      return updated.length > 0;
    },

    async requestTeardown({ sessionId, sandboxId, spriteInstanceId, at }) {
      await db
        .update(agentSessions)
        .set({ teardownRequestedAt: at, updatedAt: at })
        .where(
          and(
            eq(agentSessions.id, sessionId),
            eq(agentSessions.sandboxId, sandboxId),
            eqOrIsNull(agentSessions.spriteInstanceId, spriteInstanceId),
          ),
        );
    },

    async stampSpriteTornDown({ sessionId, sandboxId, spriteInstanceId, stamps }) {
      const updated = await db
        .update(agentSessions)
        .set({ ...stampColumns(stamps), updatedAt: now() })
        // CAS on the INSTANCE, not just the name: a concurrent re-provision may
        // have written a LIVE replacement into this row, and stamping that as
        // torn down would hide a billing VM from the reconciler forever.
        .where(
          and(
            eq(agentSessions.id, sessionId),
            eq(agentSessions.sandboxId, sandboxId),
            eqOrIsNull(agentSessions.spriteInstanceId, spriteInstanceId),
          ),
        )
        .returning({ id: agentSessions.id });
      return updated.length > 0;
    },

    async reloadSpritePointer(sessionId) {
      const [row] = await db
        .select({ sandboxId: agentSessions.sandboxId, spriteInstanceId: agentSessions.spriteInstanceId })
        .from(agentSessions)
        .where(eq(agentSessions.id, sessionId))
        .limit(1);
      return row ?? null;
    },

    async enqueueReclaim({ sandboxId, spriteInstanceId }) {
      // Mirrors the AFTER-DELETE trigger's own insert: idempotent on the
      // sandboxId PK, chasing the NEWEST instance on conflict — a newer
      // generation took this deterministic name, so the outbox pointer must
      // follow the VM that is actually alive now, not the one a stale row
      // remembers.
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
