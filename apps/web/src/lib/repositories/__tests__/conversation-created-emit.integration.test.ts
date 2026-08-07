/**
 * THE SERVER HALF of "a spawned worker appears in the sidebar without a poll
 * tick" (Agent-Session Single Source of Truth epic, Phase 2; spec §3 clause 2).
 *
 * The CLIENT half — a `conversation:created` frame arriving on the directory
 * socket inserts the row into the session directory — is proven by
 * `apps/web/src/lib/realtime/__tests__/session-directory-listener.test.ts`.
 * Nothing proved the SERVER half: that a conversation actually coming into
 * existence puts that frame on the wire, in the right room, with the right
 * payload. `chat-mutation-matrix.integration.test.ts` stubs the whole
 * `conversationEvents` object to no-ops, so by construction it cannot catch a
 * creation path that forgets to emit.
 *
 * So this suite deliberately stubs NOTHING above the transport. The seam is
 * the ONE outbound call `conversation-events.ts` makes — the signed
 * `POST <INTERNAL_REALTIME_URL>/api/broadcast` — captured by swapping
 * `globalThis.fetch`. Everything above it is the shipped code:
 * `emitConversationLifecycle` → `conversationEvents.created` →
 * `directoryRoomsFor` → `postBroadcast`, against a real Postgres.
 *
 * THE CONTRACT ASSERTED (read off conversation-rev.ts + conversation-events.ts,
 * not invented):
 *
 *   ROOM — the directory plane, `directoryRoomsFor`: always the owner's
 *   `user:<ownerId>:sessions`, PLUS the bare page room when the conversation
 *   is `isShared` AND page-scoped. Never `conv:<id>` (content plane) and never
 *   `session:<workspaceId>` — the workspace is a payload FIELD here, not a room.
 *
 *   PAYLOAD — `{ conversationId, rev, scope, workspaceId, triggeredBy,
 *   conversation: { id, title, type, contextId, workspaceId, isShared,
 *   createdAt, lastMessageAt } }`. `rev` must be a NUMBER on the wire: the
 *   column is `bigint`, every call site launders it through `Number(...)`, and
 *   a string/bigint leaking out would silently break the subscriber's
 *   `rev === watermark + 1` arithmetic.
 *
 * The four creation paths covered are every real one that exists (grep:
 * `emitConversationLifecycle('created'` has exactly three call sites):
 *
 *   1. `conversationRepository.createConversation`   (page threads)
 *   2. `globalConversationRepository.createConversation` (explicit global create)
 *   3. `resolveOrCreateConversation`                 (lazy global first-message)
 *   4. `createWorkerSession` — the epic-central spawn — which owns no INSERT
 *      of its own: it funnels through `createConversationInSession` →
 *      `createConversationInSessionWith`, which calls (3) for a global worker
 *      (`agentPageId === null`) and (1) for a page-agent worker, then binds
 *      the workspace with a SEPARATE `conversation:updated` (the claim). Both
 *      legs are asserted below, including that follow-up binding event.
 *
 * Requires DATABASE_URL → a Postgres with migrations applied. Deliberately
 * NOT skip-on-no-database: a suite that silently passes when it never ran is
 * exactly the hole this file exists to close, so an absent/unreachable DB
 * FAILS here.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { conversations } from '@pagespace/db/schema/conversations';
import { factories } from '@pagespace/db/test/factories';
import { userSessionsRoom, pageRoom } from '@pagespace/lib/realtime/rooms';
import type { ConversationDirectoryPayload } from '@/lib/websocket/conversation-events';
import { conversationRepository } from '@/lib/repositories/conversation-repository';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { resolveOrCreateConversation } from '@/app/api/ai/global/[id]/messages/resolve-or-create-conversation';
import { buildSessionToolsDeps } from '@/lib/ai/tools/session-tools-runtime';
import {
  ensureGlobalSandboxSession,
  spawnSession,
} from '@/lib/agent-workspaces/agent-sessions-runtime';

/** One captured `POST /api/broadcast` body. */
interface CapturedBroadcast {
  channelId: string;
  event: string;
  payload: ConversationDirectoryPayload;
}

const REALTIME_URL = 'http://realtime.test.invalid';
const broadcasts: CapturedBroadcast[] = [];
let originalFetch: typeof globalThis.fetch;

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/**
 * Emission is fire-and-forget (`void (async () => ...)`), so the awaited write
 * returns before the POST lands. Poll rather than sleep a fixed amount.
 */
async function waitForBroadcasts(
  predicate: (broadcast: CapturedBroadcast) => boolean,
  count: number,
  label: string,
): Promise<CapturedBroadcast[]> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const matches = broadcasts.filter(predicate);
    if (matches.length >= count) return matches;
    if (Date.now() > deadline) {
      const seen = broadcasts.map((b) => `${b.event}→${b.channelId}`);
      throw new Error(
        `Timed out waiting for ${count} broadcast(s): ${label}. Saw ${broadcasts.length}: ${JSON.stringify(seen)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Let any FURTHER (unwanted) fan-out arrive before asserting the room set. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

const createdFor = (conversationId: string) => (b: CapturedBroadcast) =>
  b.event === 'conversation:created' && b.payload.conversationId === conversationId;

const updatedFor = (conversationId: string) => (b: CapturedBroadcast) =>
  b.event === 'conversation:updated' && b.payload.conversationId === conversationId;

describe('conversation:created is genuinely EMITTED by every creation path (real DB, real emitter, transport captured)', () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is required: this suite proves a lifecycle EMIT happens, and a silent skip would re-open the exact coverage hole it closes.',
      );
    }
    // Fails loudly (rather than skipping) when the database is unreachable.
    await db.select({ id: pages.id }).from(pages).limit(1);

    process.env.INTERNAL_REALTIME_URL = REALTIME_URL;
    process.env.REALTIME_BROADCAST_SECRET =
      process.env.REALTIME_BROADCAST_SECRET ?? 'conversation-created-emit-test-secret-0123456789';

    originalFetch = globalThis.fetch;
    const captureFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.startsWith(REALTIME_URL)) {
        const body = typeof init?.body === 'string' ? init.body : '';
        broadcasts.push(JSON.parse(body) as CapturedBroadcast);
        return { ok: true, status: 200 } as unknown as Response;
      }
      return originalFetch(input, init);
    };
    globalThis.fetch = captureFetch as typeof globalThis.fetch;
  });

  afterAll(() => {
    if (originalFetch) globalThis.fetch = originalFetch;
  });

  beforeEach(() => {
    broadcasts.length = 0;
  });

  it('path 1 — conversationRepository.createConversation: emits to the owner directory room with the page scope and a numeric rev', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent' });
    const conversationId = createId();

    const outcome = await conversationRepository.createConversation(
      conversationId,
      owner.id,
      agentPage.id,
      { title: 'Page thread' },
    );
    expect(outcome).toBe('created');

    const [captured] = await waitForBroadcasts(createdFor(conversationId), 1, 'page create');
    await settle();

    // ROOM: the owner's directory room, and nothing else — private thread.
    expect(broadcasts.filter(createdFor(conversationId)).map((b) => b.channelId)).toEqual([
      userSessionsRoom(owner.id),
    ]);
    expect(captured.event).toBe('conversation:created');

    const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId));

    // PAYLOAD: base + the sidebar-insert `conversation` block.
    expect(captured.payload).toEqual({
      conversationId,
      rev: row.rev,
      scope: { kind: 'page', pageId: agentPage.id },
      workspaceId: null,
      // No explicit actor → the server stamp, so no pane self-echo-skips it.
      triggeredBy: { userId: owner.id, browserSessionId: 'server' },
      conversation: {
        id: conversationId,
        title: 'Page thread',
        type: 'page',
        contextId: agentPage.id,
        workspaceId: null,
        isShared: false,
        createdAt: row.createdAt.toISOString(),
        lastMessageAt: null,
      },
    });
    // rev survives the wire as a NUMBER (the column is bigint; every call site
    // launders it through Number(...)).
    expect(typeof captured.payload.rev).toBe('number');
    expect(captured.payload.rev).toBe(0);
  });

  it('path 1, shared — the page room joins the fan-out and an explicit triggeredBy rides the payload', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent' });
    const conversationId = createId();

    const outcome = await conversationRepository.createConversation(
      conversationId,
      owner.id,
      agentPage.id,
      {
        isShared: true,
        title: 'Shared thread',
        triggeredBy: { userId: owner.id, browserSessionId: 'pane-abc' },
      },
    );
    expect(outcome).toBe('created');

    const captured = await waitForBroadcasts(createdFor(conversationId), 2, 'shared page create');
    await settle();

    expect(broadcasts.filter(createdFor(conversationId)).map((b) => b.channelId).sort()).toEqual(
      [userSessionsRoom(owner.id), pageRoom(agentPage.id)].sort(),
    );
    for (const broadcast of captured) {
      expect(broadcast.payload.triggeredBy).toEqual({ userId: owner.id, browserSessionId: 'pane-abc' });
      expect(broadcast.payload.conversation?.isShared).toBe(true);
      expect(typeof broadcast.payload.rev).toBe('number');
    }
  });

  it('path 2 — globalConversationRepository.createConversation: emits to the owner directory room with the global scope', async () => {
    const owner = await factories.createUser();

    const created = await globalConversationRepository.createConversation(owner.id, {
      title: 'Global thread',
    });

    const [captured] = await waitForBroadcasts(createdFor(created.id), 1, 'global repo create');
    await settle();

    expect(broadcasts.filter(createdFor(created.id)).map((b) => b.channelId)).toEqual([
      userSessionsRoom(owner.id),
    ]);
    expect(captured.payload).toEqual({
      conversationId: created.id,
      rev: 0,
      scope: { kind: 'global', ownerId: owner.id },
      workspaceId: null,
      triggeredBy: { userId: owner.id, browserSessionId: 'server' },
      conversation: {
        id: created.id,
        title: 'Global thread',
        type: 'global',
        contextId: null,
        workspaceId: null,
        isShared: false,
        createdAt: created.createdAt.toISOString(),
        lastMessageAt: null,
      },
    });
    expect(typeof captured.payload.rev).toBe('number');
  });

  it('path 3 — resolveOrCreateConversation: the INSERT emits, and re-resolving the same id does not emit again', async () => {
    const owner = await factories.createUser();
    const conversationId = createId();

    const first = await resolveOrCreateConversation(owner.id, conversationId, undefined, {
      title: 'Lazy global',
    });
    expect(first.isNew).toBe(true);

    const [captured] = await waitForBroadcasts(createdFor(conversationId), 1, 'lazy global create');
    await settle();

    expect(broadcasts.filter(createdFor(conversationId)).map((b) => b.channelId)).toEqual([
      userSessionsRoom(owner.id),
    ]);
    expect(captured.payload).toEqual({
      conversationId,
      rev: 0,
      scope: { kind: 'global', ownerId: owner.id },
      workspaceId: null,
      triggeredBy: { userId: owner.id, browserSessionId: 'server' },
      conversation: {
        id: conversationId,
        title: 'Lazy global',
        type: 'global',
        contextId: null,
        workspaceId: null,
        isShared: false,
        createdAt: first.conversation.createdAt.toISOString(),
        lastMessageAt: null,
      },
    });
    expect(typeof captured.payload.rev).toBe('number');

    // Idempotent re-resolve: no row was born, so no birth announcement.
    const second = await resolveOrCreateConversation(owner.id, conversationId);
    expect(second.isNew).toBe(false);
    await settle();
    expect(broadcasts.filter(createdFor(conversationId))).toHaveLength(1);
  });

  it('path 4a — createWorkerSession (global worker): the spawn emits conversation:created, then the claim emits the workspace binding', async () => {
    const owner = await factories.createUser();
    const callerConversationId = createId();
    await resolveOrCreateConversation(owner.id, callerConversationId);
    const ensured = await ensureGlobalSandboxSession(callerConversationId, owner.id);
    if (!ensured.ok) throw new Error(`ensureGlobalSandboxSession failed: ${ensured.reason}`);

    broadcasts.length = 0;
    const workerConversationId = createId();
    const spawned = await buildSessionToolsDeps().createWorkerSession({
      conversationId: workerConversationId,
      callerConversationId,
      ownerId: owner.id,
      agentPageId: null,
      name: 'spawned worker',
      // undefined = the caller's own workspace (the epic-central spawn shape).
      workspace: undefined,
    });
    if (!spawned.ok) throw new Error(`createWorkerSession failed: ${spawned.reason}`);
    expect(spawned.workspaceId).toBe(ensured.session.id);

    const [captured] = await waitForBroadcasts(
      createdFor(workerConversationId),
      1,
      'worker spawn create',
    );
    await settle();

    // ROOM: the owner's directory room — this frame is what makes the worker
    // appear in the sidebar with no poll tick.
    expect(broadcasts.filter(createdFor(workerConversationId)).map((b) => b.channelId)).toEqual([
      userSessionsRoom(owner.id),
    ]);
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, workerConversationId));

    // A global worker funnels through resolveOrCreateConversation, so the birth
    // event is global-scoped and — because creation and binding are decoupled
    // (workspaceId is written only by the claim) — carries workspaceId null.
    expect(captured.payload).toEqual({
      conversationId: workerConversationId,
      rev: 0,
      scope: { kind: 'global', ownerId: owner.id },
      workspaceId: null,
      triggeredBy: { userId: owner.id, browserSessionId: 'server' },
      conversation: {
        id: workerConversationId,
        title: 'spawned worker',
        type: 'global',
        contextId: null,
        workspaceId: null,
        isShared: false,
        createdAt: row.createdAt.toISOString(),
        lastMessageAt: null,
      },
    });
    expect(typeof captured.payload.rev).toBe('number');

    // …and the binding arrives as its own directory event, at the NEXT rev.
    const [bound] = await waitForBroadcasts(
      updatedFor(workerConversationId),
      1,
      'worker claim binding',
    );
    expect(bound.channelId).toBe(userSessionsRoom(owner.id));
    expect(bound.payload.workspaceId).toBe(ensured.session.id);
    expect(bound.payload.changes).toEqual({
      workspaceId: ensured.session.id,
      closedInWorkspaceAt: null,
    });
    expect(bound.payload.rev).toBe(captured.payload.rev + 1);
    expect(typeof bound.payload.rev).toBe('number');
    expect(row.workspaceId).toBe(ensured.session.id);
  });

  it('path 4b — createWorkerSession (page-agent worker into an explicit workspace): emits the page-scoped birth, then the binding', async () => {
    const owner = await factories.createUser();
    const drive = await factories.createDrive(owner.id);
    const agentPage = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Drive agent' });
    const session = await spawnSession({ userId: owner.id, driveId: drive.id });
    if (!session.ok) throw new Error(`spawnSession failed: ${session.reason}`);

    broadcasts.length = 0;
    const workerConversationId = createId();
    const spawned = await buildSessionToolsDeps().createWorkerSession({
      conversationId: workerConversationId,
      callerConversationId: createId(),
      ownerId: owner.id,
      agentPageId: agentPage.id,
      name: 'page worker',
      workspace: session.session.id,
    });
    if (!spawned.ok) throw new Error(`createWorkerSession failed: ${spawned.reason}`);
    expect(spawned.workspaceId).toBe(session.session.id);

    const [captured] = await waitForBroadcasts(
      createdFor(workerConversationId),
      1,
      'page worker spawn create',
    );
    await settle();

    expect(broadcasts.filter(createdFor(workerConversationId)).map((b) => b.channelId)).toEqual([
      userSessionsRoom(owner.id),
    ]);
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, workerConversationId));

    // A page-agent worker funnels through conversationRepository.createConversation.
    expect(captured.payload).toEqual({
      conversationId: workerConversationId,
      rev: 0,
      scope: { kind: 'page', pageId: agentPage.id },
      workspaceId: null,
      triggeredBy: { userId: owner.id, browserSessionId: 'server' },
      conversation: {
        id: workerConversationId,
        title: 'page worker',
        type: 'page',
        contextId: agentPage.id,
        workspaceId: null,
        isShared: false,
        createdAt: row.createdAt.toISOString(),
        lastMessageAt: null,
      },
    });
    expect(typeof captured.payload.rev).toBe('number');

    const [bound] = await waitForBroadcasts(
      updatedFor(workerConversationId),
      1,
      'page worker claim binding',
    );
    expect(bound.channelId).toBe(userSessionsRoom(owner.id));
    expect(bound.payload.changes).toEqual({
      workspaceId: session.session.id,
      closedInWorkspaceAt: null,
    });
    expect(bound.payload.rev).toBe(captured.payload.rev + 1);
    expect(row.workspaceId).toBe(session.session.id);
  });
});
