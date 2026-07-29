/**
 * Agent Sessions store (IO, dependency-injected).
 *
 * DB-backed CRUD for `agent_sessions` — one row per conversation that has
 * lazily acquired a sandbox. Kept separate from the lifecycle orchestration
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
 *  - **No conversation writes.** `agent_sessions.conversationId` is a FK, so the
 *    conversations row must already exist; creating it goes through the
 *    squat-guarded repository path, injected into `ensureAgentSession` as a dep
 *    (see its `ensureConversation`). A store that could insert conversations
 *    itself would be a second, unguarded way to claim a conversation id.
 */

import type { AgentSessionRowStamps } from '../../agent-sessions/plan-session-lifecycle';

/** One `agent_sessions` row. `conversationId` IS the sessionId (see `contract.ts`). */
export interface AgentSessionRecord {
  /** ≡ sessionId. The PK, the Sprite-key fold, the `?c=` URL value. */
  conversationId: string;
  ownerId: string;
  /** null = a global-assistant session (no agent page to derive access or billing from). */
  agentPageId: string | null;
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
  /** ≡ sessionId — supplied by the caller (client-minted cuid2), never generated here. */
  conversationId: string;
  ownerId: string;
  agentPageId: string | null;
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
  | { agentPageId: string; ownerId?: string }
  | { driveId: string; ownerId?: string }
  | { ownerId: string };

export interface AgentSessionStore {
  findById(sessionId: string): Promise<AgentSessionRecord | null>;
  /**
   * Create the session row if it does not exist yet — `INSERT … ON CONFLICT
   * (conversationId) DO NOTHING`, the PK being the conversation id.
   *
   * Idempotent by construction, which is the whole point: two concurrent first
   * touches of one conversation (a sandbox tool call and a shell open, say) both
   * run this and exactly one row results, with NEITHER caller erroring. It
   * reports nothing about which one won because nothing downstream may depend on
   * that — the caller re-selects.
   */
  insertIfAbsent(input: NewAgentSessionInput): Promise<void>;
  list(filter: AgentSessionListFilter): Promise<AgentSessionRecord[]>;
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
   * `services/sandbox/sandbox-storage-measure.ts`). Separate from
   * `updateSpriteIdentity` because it is a pure billing observation, not a
   * lifecycle transition: it carries no CAS and must never disturb identity or
   * teardown stamps.
   *
   * Guarded on the row still being live (`spriteTornDownAt IS NULL`): a
   * measurement that lands after teardown describes a filesystem that no longer
   * exists, and writing it would bill the next generation against a dead disk.
   */
  recordStorageMeasurement(input: {
    sessionId: string;
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
  /** Write a verdict's stamps with no CAS — for verdicts that change no identity (a resume's activity touch, ending a session that never provisioned). */
  applyStamps(input: { sessionId: string; stamps: AgentSessionRowStamps }): Promise<void>;
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
 */
export async function createDbAgentSessionStore(): Promise<AgentSessionStore> {
  const [{ db }, { eq, and, eqOrIsNull, isNotNull, isNull, sql, count }, { agentSessions }, { machineSpriteReclaims }, { pages }] =
    await Promise.all([
      import('@pagespace/db/db'),
      import('@pagespace/db/operators'),
      import('@pagespace/db/schema/agent-sessions'),
      import('@pagespace/db/schema/machine-sprite-reclaims'),
      import('@pagespace/db/schema/core'),
    ]);

  return {
    async findById(sessionId) {
      const [row] = await db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.conversationId, sessionId))
        .limit(1);
      return (row as AgentSessionRecord) ?? null;
    },

    async insertIfAbsent(input) {
      await db
        .insert(agentSessions)
        .values({
          conversationId: input.conversationId,
          ownerId: input.ownerId,
          agentPageId: input.agentPageId,
          name: input.name,
          createdAt: input.now,
          updatedAt: input.now,
        })
        // The PK is the conversation id, so this is the whole concurrency story:
        // whichever first touch of a conversation gets there first wins, and the
        // other proceeds as if it had.
        .onConflictDoNothing({ target: agentSessions.conversationId });
    },

    async list(filter) {
      const conditions = [];
      if ('agentPageId' in filter) conditions.push(eq(agentSessions.agentPageId, filter.agentPageId));
      if (filter.ownerId !== undefined) conditions.push(eq(agentSessions.ownerId, filter.ownerId));
      if ('driveId' in filter) {
        // A session's drive is its agent page's drive; a global-assistant
        // session (null `agentPageId`) belongs to no drive and so never appears
        // in a drive-scoped listing. The inner join expresses both.
        const rows = await db
          .select({ session: agentSessions })
          .from(agentSessions)
          .innerJoin(pages, eq(pages.id, agentSessions.agentPageId))
          .where(and(eq(pages.driveId, filter.driveId), ...conditions));
        return rows.map((row) => row.session as AgentSessionRecord);
      }
      if (conditions.length === 0) {
        // Unreachable through `AgentSessionListFilter`, which requires a
        // narrowing key. Defensive only: an unfiltered enumeration would be a
        // cross-tenant read, so it fails loudly rather than returning it.
        throw new Error('listAgentSessions requires at least one filter');
      }
      const rows = await db.select().from(agentSessions).where(and(...conditions));
      return rows as AgentSessionRecord[];
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

    async recordStorageMeasurement({ sessionId, measuredBytes, measuredAt }) {
      await db
        .update(agentSessions)
        .set({ storageMeasuredBytes: measuredBytes, storageMeasuredAt: measuredAt })
        .where(
          and(
            eq(agentSessions.conversationId, sessionId),
            isNull(agentSessions.spriteTornDownAt),
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
            eq(agentSessions.conversationId, sessionId),
            // CAS on the CURRENT sandboxId: null for a first provision, the
            // vanished/replaced name for a re-provision. `eqOrIsNull` matches
            // the null case, which plain `eq` never does in SQL.
            eqOrIsNull(agentSessions.sandboxId, previousSandboxId),
          ),
        )
        .returning({ id: agentSessions.conversationId });
      return updated.length > 0;
    },

    async applyStamps({ sessionId, stamps }) {
      const columns = stampColumns(stamps);
      // Nothing to write is a legitimate verdict (a noop that stamps nothing);
      // an empty `set` is a SQL error, so it is skipped rather than special-cased
      // by every caller.
      if (Object.keys(columns).length === 0) return;
      await db
        .update(agentSessions)
        .set({ ...columns, updatedAt: new Date() })
        .where(eq(agentSessions.conversationId, sessionId));
    },

    async requestTeardown({ sessionId, sandboxId, spriteInstanceId, at }) {
      await db
        .update(agentSessions)
        .set({ teardownRequestedAt: at, updatedAt: at })
        .where(
          and(
            eq(agentSessions.conversationId, sessionId),
            eq(agentSessions.sandboxId, sandboxId),
            eqOrIsNull(agentSessions.spriteInstanceId, spriteInstanceId),
          ),
        );
    },

    async stampSpriteTornDown({ sessionId, sandboxId, spriteInstanceId, stamps }) {
      const updated = await db
        .update(agentSessions)
        .set({ ...stampColumns(stamps), updatedAt: new Date() })
        // CAS on the INSTANCE, not just the name: a concurrent re-provision may
        // have written a LIVE replacement into this row, and stamping that as
        // torn down would hide a billing VM from the reconciler forever.
        .where(
          and(
            eq(agentSessions.conversationId, sessionId),
            eq(agentSessions.sandboxId, sandboxId),
            eqOrIsNull(agentSessions.spriteInstanceId, spriteInstanceId),
          ),
        )
        .returning({ id: agentSessions.conversationId });
      return updated.length > 0;
    },

    async reloadSpritePointer(sessionId) {
      const [row] = await db
        .select({ sandboxId: agentSessions.sandboxId, spriteInstanceId: agentSessions.spriteInstanceId })
        .from(agentSessions)
        .where(eq(agentSessions.conversationId, sessionId))
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
