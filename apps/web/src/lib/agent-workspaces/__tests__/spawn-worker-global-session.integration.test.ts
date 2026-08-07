/**
 * Regression tests for issue #2335 — spawn_session from the global assistant.
 *
 * Two facts proven against a REAL migration-built Postgres:
 *
 *  1. The happy path works end-to-end: a global caller's session is
 *     auto-minted and the worker conversation (agentPageId null) lands in it.
 *     `conversations.updatedAt` has NO DB default here (exactly as migration
 *     0000 created it) — the insert succeeds because
 *     `resolveOrCreateConversation` sets `updatedAt: new Date()` explicitly
 *     (this PR's Fix 2, matching the page path). The issue's original
 *     hypothesis — that the missing default was itself the bug — was
 *     evaluated separately by inspecting drizzle-orm 0.45.2's insert
 *     compiler (`pg-core/dialect.js`'s `buildInsertQuery`), which fills a
 *     default-less `$onUpdate` column on INSERT too; this test does not
 *     exercise that fallback (the explicit set makes it moot) and makes no
 *     claim about it.
 *
 *  2. The actual root cause: a conversation bound to an ENDED session used to
 *     dead-end every spawn with a generic `conversation_unavailable` blaming
 *     the conversation id. Sessions are resumable by the lifecycle's own
 *     model, so the fix is to USE the bound session regardless of lifecycle
 *     state: the worker's claim reopens the listing (`planSessionReopen`) and
 *     the next provision fresh-creates the sandbox through the ordinary
 *     ensure path.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable — a silent skip
 * would be a green, zero-assertion pass. Local runs without Docker opt out
 * explicitly with ALLOW_SKIP_DB_TESTS=1.
 * Mirrors the other integration tests in this directory.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { factories } from '@pagespace/db/test/factories';
import { resolveOrCreateConversation } from '@/app/api/ai/global/[id]/messages/resolve-or-create-conversation';
import {
  buildSessionToolsDeps,
  resolveCallerSessionForWorker,
} from '@/lib/ai/tools/session-tools-runtime';
import {
  createConversationInSession,
  ensureGlobalSandboxSession,
} from '../agent-sessions-runtime';
import { requireDb } from '@pagespace/db/test/require-db';

let dbAvailable = false;

describe('spawn_session from the global assistant (issue #2335)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('spawn-worker-global-session.integration.test.ts', error);
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
      workspaceId: ensured.session.id,
      title: 'repro worker',
    });

    const [worker] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, workerConversationId));
    expect(worker).toBeDefined();
    expect(worker.type).toBe('global');
    expect(worker.workspaceId).toBe(ensured.session.id);
    expect(worker.title).toBe('repro worker');
  });

  it('a global conversation bound to an ENDED session spawns anyway — the session is used as-is and its listing REOPENS when the worker claims in (issue #2335)', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const callerConversationId = createId();
    await resolveOrCreateConversation(owner.id, callerConversationId);
    const ensured = await ensureGlobalSandboxSession(callerConversationId, owner.id);
    if (!ensured.ok) throw new Error(`ensureGlobalSandboxSession failed: ${ensured.reason}`);

    // The session ends (user action, reconciler, teardown…).
    await db
      .update(agentWorkspaces)
      .set({ endedAt: new Date() })
      .where(eq(agentWorkspaces.id, ensured.session.id));

    // Resolution hands back the bound session — lifecycle state is not a
    // refusal (pre-fix, the create path's generic conversation_unavailable
    // blamed the conversation id here — the reported bug).
    const resolved = await resolveCallerSessionForWorker(callerConversationId, owner.id);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.session.id).toBe(ensured.session.id);

    // The worker lands in that SAME workspace…
    const workerConversationId = createId();
    await createConversationInSession({
      conversationId: workerConversationId,
      userId: owner.id,
      agentPageId: null,
      workspaceId: ensured.session.id,
      title: 'recovered worker',
    });
    const [worker] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, workerConversationId));
    expect(worker.workspaceId).toBe(ensured.session.id);

    // …and the claim reopened the session's listing: the end-intent stamp is
    // withdrawn, so the workspace is visible in the sidebar again.
    const [session] = await db
      .select()
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.id, ensured.session.id));
    expect(session.endedAt).toBeNull();
  });

  it('workspace placement: "new" mints an ISOLATED workspace, an explicit workspaceId targets it, a foreign workspaceId refuses, and the listing discovers it all', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    const callerConversationId = createId();
    await resolveOrCreateConversation(owner.id, callerConversationId);
    const ensured = await ensureGlobalSandboxSession(callerConversationId, owner.id);
    if (!ensured.ok) throw new Error(`ensureGlobalSandboxSession failed: ${ensured.reason}`);
    const deps = buildSessionToolsDeps();

    // 'new' → a fresh workspace, NOT the caller's.
    const isolatedWorkerId = createId();
    const isolated = await deps.createWorkerSession({
      conversationId: isolatedWorkerId,
      callerConversationId,
      ownerId: owner.id,
      agentPageId: null,
      name: 'isolated worker',
      workspace: 'new',
    });
    if (!isolated.ok) throw new Error(`isolated spawn failed: ${isolated.reason}`);
    expect(isolated.workspaceId).not.toBe(ensured.session.id);
    const [isolatedWorker] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, isolatedWorkerId));
    expect(isolatedWorker.workspaceId).toBe(isolated.workspaceId);

    // Explicit target → lands exactly there (here: back in the caller's own).
    const targetedWorkerId = createId();
    const targeted = await deps.createWorkerSession({
      conversationId: targetedWorkerId,
      callerConversationId,
      ownerId: owner.id,
      agentPageId: null,
      name: 'targeted worker',
      workspace: ensured.session.id,
    });
    if (!targeted.ok) throw new Error(`targeted spawn failed: ${targeted.reason}`);
    expect(targeted.workspaceId).toBe(ensured.session.id);

    // A workspace the caller cannot use reads as nonexistent.
    const stranger = await factories.createUser();
    const strangerConversationId = createId();
    await resolveOrCreateConversation(stranger.id, strangerConversationId);
    const strangerSession = await ensureGlobalSandboxSession(strangerConversationId, stranger.id);
    if (!strangerSession.ok) throw new Error('stranger session failed');
    const denied = await deps.createWorkerSession({
      conversationId: createId(),
      callerConversationId,
      ownerId: owner.id,
      agentPageId: null,
      name: 'trespasser',
      workspace: strangerSession.session.id,
    });
    expect(denied).toMatchObject({ ok: false, reason: 'workspace_not_found' });

    // Discovery: the isolated workspace and its worker appear in the
    // caller's cross-workspace listing, excluded-current respected.
    const others = await deps.listOwnWorkspaces({
      userId: owner.id,
      excludeWorkspaceId: ensured.session.id,
    });
    const isolatedListed = others.find((w) => w.workspaceId === isolated.workspaceId);
    expect(isolatedListed).toBeDefined();
    expect(isolatedListed?.workers.map((w) => w.sessionId)).toContain(isolatedWorkerId);
    expect(others.find((w) => w.workspaceId === ensured.session.id)).toBeUndefined();
  });
});
