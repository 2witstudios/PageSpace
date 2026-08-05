/**
 * Regression tests for issue #2335 — spawn_session from the global assistant.
 *
 * Two facts proven against a REAL migration-built Postgres:
 *
 *  1. The happy path works end-to-end: a global caller's session is
 *     auto-minted and the worker conversation (agentPageId null) lands in it.
 *     This is also the direct refutation of the issue's first hypothesis —
 *     `conversations.updatedAt` has NO DB default here (exactly as migration
 *     0000 created it), and the global insert still succeeds, because drizzle
 *     fills a default-less `$onUpdate` column on INSERT.
 *
 *  2. The actual root cause: a conversation bound to an ENDED session. The
 *     binding is write-once, so such a conversation can never join a live
 *     session again — `resolveCallerSessionForWorker` must refuse truthfully
 *     (`session_ended`), not hand the dead session to the create path, whose
 *     generic `conversation_unavailable` blamed the conversation id.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). Skipped when no DB is reachable —
 * mirrors the other integration tests in this directory.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentSessions } from '@pagespace/db/schema/agent-sessions';
import { factories } from '@pagespace/db/test/factories';
import { resolveOrCreateConversation } from '@/app/api/ai/global/[id]/messages/resolve-or-create-conversation';
import { resolveCallerSessionForWorker } from '@/lib/ai/tools/session-tools-runtime';
import {
  createConversationInSession,
  ensureGlobalSandboxSession,
} from '../agent-sessions-runtime';

let dbAvailable = false;

describe('spawn_session from the global assistant (issue #2335)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  it('creates the worker conversation in the auto-minted global session', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();

    // 1. The caller's global-assistant conversation (lazy first-message create).
    const callerConversationId = createId();
    const resolved = await resolveOrCreateConversation(owner.id, callerConversationId);
    expect(resolved.isNew).toBe(true);

    // 2. The session a worker would join — auto-minted for a global caller.
    const ensured = await ensureGlobalSandboxSession(callerConversationId, owner.id);
    if (!ensured.ok) throw new Error(`ensureGlobalSandboxSession failed: ${ensured.reason}`);

    // 3. The worker conversation itself — createWorkerSession's inner call.
    const workerConversationId = createId();
    await createConversationInSession({
      conversationId: workerConversationId,
      userId: owner.id,
      agentPageId: null,
      sessionId: ensured.session.id,
      title: 'repro worker',
    });

    const [worker] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, workerConversationId));
    expect(worker).toBeDefined();
    expect(worker.type).toBe('global');
    expect(worker.sessionId).toBe(ensured.session.id);
    expect(worker.title).toBe('repro worker');
  });

  it('a global conversation bound to an ENDED session refuses with session_ended, not conversation_unavailable', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const callerConversationId = createId();
    await resolveOrCreateConversation(owner.id, callerConversationId);
    const ensured = await ensureGlobalSandboxSession(callerConversationId, owner.id);
    if (!ensured.ok) throw new Error(`ensureGlobalSandboxSession failed: ${ensured.reason}`);

    // The session ends (user action, reconciler, teardown…).
    await db
      .update(agentSessions)
      .set({ endedAt: new Date() })
      .where(eq(agentSessions.id, ensured.session.id));

    // The resolution refuses truthfully instead of handing back the dead
    // session (pre-fix, this returned ok:true and the create path's generic
    // refusal blamed the conversation id — the reported bug).
    const resolved = await resolveCallerSessionForWorker(callerConversationId, owner.id);
    expect(resolved).toEqual({ ok: false, reason: 'session_ended' });

    // The create path's own ended-session gate still holds as the backstop,
    // and now names its gate via `cause` for the boundary's log.
    await expect(
      createConversationInSession({
        conversationId: createId(),
        userId: owner.id,
        agentPageId: null,
        sessionId: ensured.session.id,
        title: 'doomed worker',
      }),
    ).rejects.toMatchObject({
      name: 'ConversationUnavailableError',
      cause: expect.objectContaining({ message: 'session_ended' }),
    });
  });
});
