/**
 * The per-session open-listing cap (`MAX_SESSION_CONVERSATIONS`) under REAL
 * concurrency — a mocked-DB unit test can prove the pure decision logic, but
 * "does the advisory lock actually serialize two genuinely concurrent
 * transactions" needs a real Postgres, since that's exactly the property a
 * mock can't exercise.
 *
 * The bug this guards (review finding, chatgpt-codex-connector on PR #2296):
 * `createConversationInSession` and `reopenConversationInSession` both count
 * open listings against the same cap, but only `reopenConversationInSession`
 * (and `closeConversationInSession`) took the per-session advisory lock.
 * A create racing a reopen for the session's LAST open slot could both read
 * the count before either wrote, and both succeed — exceeding the cap.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable —
 * mirrors `agent-sessions-conversations-runtime.integration.test.ts` in this
 * same directory.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, and, isNull, count } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { agentSessions } from '@pagespace/db/schema/agent-sessions';
import { conversations } from '@pagespace/db/schema/conversations';
import { factories } from '@pagespace/db/test/factories';
import { MAX_SESSION_CONVERSATIONS } from '@pagespace/lib/agent-sessions/plan-spawn-session';
import {
  claimConversationInSession,
  createConversationInSession,
  reopenConversationInSession,
} from '../agent-sessions-runtime';
import { SessionFullError } from '../create-conversation-in-session';

let dbAvailable = false;

describe('create/reopen — the open-listing cap serializes across BOTH operations, under real concurrency', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  async function openCountFor(sessionId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.sessionId, sessionId),
          eq(conversations.isActive, true),
          isNull(conversations.closedInSessionAt),
        ),
      );
    return row?.n ?? 0;
  }

  it('a create racing a reopen for the session\'s LAST slot: exactly one wins, the count never exceeds the cap', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Race Agent' });
    const [session] = await db.insert(agentSessions).values({ id: createId(), driveId: drive.id, ownerId: owner.id }).returning();

    // Bring the session to exactly ONE slot below the cap with plain rows
    // (bypassing the create path — this test is about the cap's own
    // serialization, not about creation itself).
    const filler = Array.from({ length: MAX_SESSION_CONVERSATIONS - 1 }, () => ({
      id: createId(),
      userId: owner.id,
      type: 'page' as const,
      contextId: agentPage.id,
      sessionId: session.id,
      isActive: true,
    }));
    await db.insert(conversations).values(filler);

    // The ONE closed conversation available to reopen — contends for the
    // same last slot the concurrent create is also trying to claim.
    const closedConversationId = createId();
    await db.insert(conversations).values({
      id: closedConversationId,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      sessionId: session.id,
      isActive: true,
      closedInSessionAt: new Date(),
    });

    expect(await openCountFor(session.id)).toBe(MAX_SESSION_CONVERSATIONS - 1);

    const newConversationId = createId();
    const [createResult, reopenResult] = await Promise.allSettled([
      createConversationInSession({
        conversationId: newConversationId,
        userId: owner.id,
        agentPageId: agentPage.id,
        sessionId: session.id,
      }),
      reopenConversationInSession({ conversationId: closedConversationId, sessionId: session.id }),
    ]);

    // Exactly one of the two must have been refused — never both succeeding
    // (that would exceed the cap) and never both refused (the session
    // legitimately had room for one more). Mutually exclusive by
    // construction: a refusal is EITHER a rejection (create's `SessionFullError`)
    // OR a fulfilled 'session_full' (reopen's refusal return value) — never
    // both counted for the same outcome.
    const isRefused = (o: PromiseSettledResult<unknown>) =>
      o.status === 'rejected' || (o.status === 'fulfilled' && o.value === 'session_full');
    const outcomes = [createResult, reopenResult];
    const refused = outcomes.filter(isRefused);
    const succeeded = outcomes.filter((o) => !isRefused(o));
    expect(succeeded).toHaveLength(1);
    expect(refused).toHaveLength(1);

    // The refused side must be refused for the RIGHT reason (the cap), not
    // some unrelated failure masking a real bug.
    if (createResult.status === 'rejected') {
      expect(createResult.reason).toBeInstanceOf(SessionFullError);
    }
    // Unlike create, reopen never REJECTS for a cap refusal — it RETURNS
    // 'session_full'. `isRefused` above treats any rejection as a
    // legitimate cap refusal, so a reopen rejecting for an unrelated reason
    // (e.g. `SessionListingLockBusyError`) would silently pass as "refused"
    // here without this explicit fulfilled check (review finding —
    // coderabbitai on PR #2296).
    expect(reopenResult.status).toBe('fulfilled');
    if (reopenResult.status === 'fulfilled') {
      expect(reopenResult.value === 'reopened' || reopenResult.value === 'session_full').toBe(true);
    }

    // The load-bearing assertion: the real, final row count in the database
    // is exactly at the cap — never over it.
    expect(await openCountFor(session.id)).toBe(MAX_SESSION_CONVERSATIONS);
  }, 20_000);
});

describe('claim — real concurrency (the guarded UPDATE, not the advisory lock, is what serializes it)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  async function openCountFor(sessionId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(conversations)
      .where(
        and(
          eq(conversations.sessionId, sessionId),
          eq(conversations.isActive, true),
          isNull(conversations.closedInSessionAt),
        ),
      );
    return row?.n ?? 0;
  }

  it('two concurrent claims of the SAME conversation into TWO DIFFERENT sessions: exactly one wins, even though the two sessions take different lock keys', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Claim Race Agent' });
    const [sessionA] = await db.insert(agentSessions).values({ id: createId(), driveId: drive.id, ownerId: owner.id }).returning();
    const [sessionB] = await db.insert(agentSessions).values({ id: createId(), driveId: drive.id, ownerId: owner.id }).returning();

    const conversationId = createId();
    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      sessionId: null,
      isActive: true,
    });

    const [resultA, resultB] = await Promise.all([
      claimConversationInSession({ conversationId, userId: owner.id, sessionId: sessionA.id }),
      claimConversationInSession({ conversationId, userId: owner.id, sessionId: sessionB.id }),
    ]);

    // `withSessionListingLock` locks per-SESSION — sessionA and sessionB take
    // DIFFERENT keys, so the lock provides no mutual exclusion between these
    // two calls at all. The `sessionId IS NULL` predicate in the guarded
    // UPDATE is the only thing serializing this correctly.
    const outcomes = [resultA, resultB];
    expect(outcomes.filter((o) => o === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'not_found')).toHaveLength(1);

    const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    const winnerSessionId = resultA === 'claimed' ? sessionA.id : sessionB.id;
    expect(row.sessionId).toBe(winnerSessionId);
  }, 20_000);

  it('two concurrent claims of the SAME conversation into the SAME session: one claimed, one already_in_session, exactly one row bound', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Same-Session Claim Race' });
    const [session] = await db.insert(agentSessions).values({ id: createId(), driveId: drive.id, ownerId: owner.id }).returning();

    const conversationId = createId();
    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      sessionId: null,
      isActive: true,
    });

    const outcomes = await Promise.all([
      claimConversationInSession({ conversationId, userId: owner.id, sessionId: session.id }),
      claimConversationInSession({ conversationId, userId: owner.id, sessionId: session.id }),
    ]);

    expect(outcomes.filter((o) => o === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already_in_session')).toHaveLength(1);
    expect(await openCountFor(session.id)).toBe(1);
  }, 20_000);

  it("claim racing create for the session's LAST slot: exactly one wins, the count never exceeds the cap", async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Claim-vs-Create Race' });
    const [session] = await db.insert(agentSessions).values({ id: createId(), driveId: drive.id, ownerId: owner.id }).returning();

    const filler = Array.from({ length: MAX_SESSION_CONVERSATIONS - 1 }, () => ({
      id: createId(),
      userId: owner.id,
      type: 'page' as const,
      contextId: agentPage.id,
      sessionId: session.id,
      isActive: true,
    }));
    await db.insert(conversations).values(filler);

    // The ONE never-bound conversation available to claim — contends for
    // the same last slot the concurrent create is also trying to fill.
    const claimableConversationId = createId();
    await db.insert(conversations).values({
      id: claimableConversationId,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      sessionId: null,
      isActive: true,
    });

    expect(await openCountFor(session.id)).toBe(MAX_SESSION_CONVERSATIONS - 1);

    const newConversationId = createId();
    const [createResult, claimResult] = await Promise.allSettled([
      createConversationInSession({
        conversationId: newConversationId,
        userId: owner.id,
        agentPageId: agentPage.id,
        sessionId: session.id,
      }),
      claimConversationInSession({ conversationId: claimableConversationId, userId: owner.id, sessionId: session.id }),
    ]);

    const isRefused = (o: PromiseSettledResult<unknown>) =>
      o.status === 'rejected' || (o.status === 'fulfilled' && o.value === 'session_full');
    const outcomes = [createResult, claimResult];
    expect(outcomes.filter((o) => !isRefused(o))).toHaveLength(1);
    expect(outcomes.filter(isRefused)).toHaveLength(1);

    if (createResult.status === 'rejected') {
      expect(createResult.reason).toBeInstanceOf(SessionFullError);
    }
    expect(claimResult.status).toBe('fulfilled');
    if (claimResult.status === 'fulfilled') {
      expect(claimResult.value === 'claimed' || claimResult.value === 'session_full').toBe(true);
    }

    expect(await openCountFor(session.id)).toBe(MAX_SESSION_CONVERSATIONS);
  }, 20_000);

  it('a row with sessionId: null but closedInSessionAt still set (FK-set-null residue) claims successfully and comes back OPEN', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Residue Agent' });
    const [oldSession] = await db.insert(agentSessions).values({ id: createId(), driveId: drive.id, ownerId: owner.id }).returning();
    const [newSession] = await db.insert(agentSessions).values({ id: createId(), driveId: drive.id, ownerId: owner.id }).returning();

    const conversationId = createId();
    // Simulate the residue: bound to oldSession, closed, then oldSession
    // deleted (ON DELETE SET NULL clears sessionId but NOT closedInSessionAt).
    await db.insert(conversations).values({
      id: conversationId,
      userId: owner.id,
      type: 'page',
      contextId: agentPage.id,
      sessionId: oldSession.id,
      isActive: true,
      closedInSessionAt: new Date(),
    });
    await db.delete(agentSessions).where(eq(agentSessions.id, oldSession.id));

    const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    expect(row.sessionId).toBeNull();
    expect(row.closedInSessionAt).not.toBeNull();

    const outcome = await claimConversationInSession({ conversationId, userId: owner.id, sessionId: newSession.id });
    expect(outcome).toBe('claimed');

    const [claimed] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    expect(claimed.sessionId).toBe(newSession.id);
    expect(claimed.closedInSessionAt).toBeNull();
    expect(await openCountFor(newSession.id)).toBe(1);
  }, 20_000);
});
