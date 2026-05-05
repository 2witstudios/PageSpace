/**
 * Contract tests for /api/channels/[pageId]/messages
 *
 * Focuses on the thread-support extensions added in PR 3:
 *   - GET ?parentId= returns ascending replies for a top-level parent
 *   - POST { parentId } routes through insertChannelThreadReply
 *   - POST { parentId, alsoSendToParent } emits two new_message broadcasts
 *   - thread_reply_count_updated fires after a reply commits
 *   - Validation: missing parent → 404, wrong page → 400, depth-2 → 400
 *
 * The repository seam (`channelMessageRepository`) is mocked so assertions
 * exercise the route's validation, broadcast fanout, and audit log without
 * touching the ORM chain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// --- Auth boundary -------------------------------------------------------------
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(
    (r: unknown) => typeof r === 'object' && r !== null && 'error' in r
  ),
  checkMCPPageScope: vi.fn().mockResolvedValue(null),
}));

// --- Permissions ---------------------------------------------------------------
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn().mockResolvedValue(true),
  canUserEditPage: vi.fn().mockResolvedValue(true),
}));

// --- Channel repository seam --------------------------------------------------
const mockListChannelMessages = vi.fn();
const mockListChannelThreadReplies = vi.fn();
const mockFindChannelMessageInPage = vi.fn();
const mockInsertChannelMessage = vi.fn();
const mockInsertChannelThreadReply = vi.fn();
const mockUpsertChannelReadStatus = vi.fn();
const mockLoadChannelMessageWithRelations = vi.fn();
const mockFileExists = vi.fn();
const mockListChannelThreadFollowers = vi.fn();
vi.mock('@pagespace/lib/services/channel-message-repository', () => ({
  channelMessageRepository: {
    listChannelMessages: (...args: unknown[]) => mockListChannelMessages(...args),
    listChannelThreadReplies: (...args: unknown[]) => mockListChannelThreadReplies(...args),
    findChannelMessageInPage: (...args: unknown[]) => mockFindChannelMessageInPage(...args),
    insertChannelMessage: (...args: unknown[]) => mockInsertChannelMessage(...args),
    insertChannelThreadReply: (...args: unknown[]) => mockInsertChannelThreadReply(...args),
    upsertChannelReadStatus: (...args: unknown[]) => mockUpsertChannelReadStatus(...args),
    loadChannelMessageWithRelations: (...args: unknown[]) => mockLoadChannelMessageWithRelations(...args),
    fileExists: (...args: unknown[]) => mockFileExists(...args),
    listChannelThreadFollowers: (...args: unknown[]) => mockListChannelThreadFollowers(...args),
  },
}));

// --- DB seam (only for the inbox-fanout block in the top-level POST path) -----
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
      driveMembers: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  gt: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  or: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({ pages: {} }));
vi.mock('@pagespace/db/schema/members', () => ({ driveMembers: {}, pagePermissions: {} }));

// --- Audit + logger seams ------------------------------------------------------
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    realtime: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

// --- Realtime broadcast helpers ------------------------------------------------
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({ 'x-signed': 'yes' })),
}));

const mockBroadcastInboxEvent = vi.fn();
const mockBroadcastThreadReplyCountUpdated = vi.fn();
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: (...args: unknown[]) => mockBroadcastInboxEvent(...args),
  broadcastThreadReplyCountUpdated: (...args: unknown[]) => mockBroadcastThreadReplyCountUpdated(...args),
}));

// Avoid loading the agent mention responder module — it has its own real deps.
vi.mock('@/lib/channels/agent-mention-responder', () => ({
  triggerMentionedAgentResponses: vi.fn(),
}));

// --- Imports under test --------------------------------------------------------
import { GET, POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// --- Fixtures ------------------------------------------------------------------
const PAGE_ID = 'page_chan';
const USER_ID = 'user_sender';
const PARENT_ID = 'parent_msg';

const sessionAuth = (userId = USER_ID): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_test',
  role: 'user',
  adminRoleVersion: 0,
});

const authError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

function makeGetRequest(qs = ''): Request {
  return new Request(`http://localhost/api/channels/${PAGE_ID}/messages${qs}`, {
    method: 'GET',
  });
}

function makePostRequest(body: unknown): Request {
  return new Request(`http://localhost/api/channels/${PAGE_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const callGet = (qs = '') =>
  GET(makeGetRequest(qs), { params: Promise.resolve({ pageId: PAGE_ID }) });

const callPost = (body: unknown) =>
  POST(makePostRequest(body), { params: Promise.resolve({ pageId: PAGE_ID }) });

function captureRealtimeBroadcasts(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls
    .filter(([url]) => typeof url === 'string' && url.includes('/api/broadcast'))
    .map(([, init]) => {
      const body = (init as RequestInit).body;
      if (typeof body !== 'string') return null;
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    })
    .filter((p): p is { channelId: string; event: string; payload: unknown } => p !== null);
}

// --- GET ?parentId= ------------------------------------------------------------
describe('GET /api/channels/[pageId]/messages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    // PR 5: thread GET also looks up followers to populate isFollowing.
    // Default to an empty list so non-thread paths don't trip on undefined.
    mockListChannelThreadFollowers.mockResolvedValue([]);
  });

  it('routes to listChannelThreadReplies when ?parentId= is provided', async () => {
    mockFindChannelMessageInPage.mockResolvedValueOnce({
      id: PARENT_ID,
      pageId: PAGE_ID,
      parentId: null,
      isActive: true,
    });
    mockListChannelThreadReplies.mockResolvedValueOnce([]);

    const res = await callGet(`?parentId=${PARENT_ID}`);

    expect(res.status).toBe(200);
    expect(mockListChannelThreadReplies).toHaveBeenCalledWith(
      expect.objectContaining({ rootId: PARENT_ID })
    );
    expect(mockListChannelMessages).not.toHaveBeenCalled();
  });

  it('returns 404 when ?parentId= refers to a message not in this channel', async () => {
    mockFindChannelMessageInPage.mockResolvedValueOnce(null);

    const res = await callGet(`?parentId=${PARENT_ID}`);

    expect(res.status).toBe(404);
    expect(mockListChannelThreadReplies).not.toHaveBeenCalled();
  });

  it('returns 404 when ?parentId= refers to a soft-deleted parent (clients cannot enumerate replies of a tombstoned thread)', async () => {
    mockFindChannelMessageInPage.mockResolvedValueOnce({
      id: PARENT_ID,
      pageId: PAGE_ID,
      parentId: null,
      isActive: false,
    });

    const res = await callGet(`?parentId=${PARENT_ID}`);

    expect(res.status).toBe(404);
    expect(mockListChannelThreadReplies).not.toHaveBeenCalled();
  });

  it('returns 400 when ?parentId= refers to a message that is itself a reply (depth-2 fetch)', async () => {
    mockFindChannelMessageInPage.mockResolvedValueOnce({
      id: PARENT_ID,
      pageId: PAGE_ID,
      parentId: 'some-other-parent',
      isActive: true,
    });

    const res = await callGet(`?parentId=${PARENT_ID}`);

    expect(res.status).toBe(400);
    expect(mockListChannelThreadReplies).not.toHaveBeenCalled();
  });

  it('without ?parentId= falls back to top-level listChannelMessages (existing behavior)', async () => {
    mockListChannelMessages.mockResolvedValueOnce([]);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(mockListChannelMessages).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: PAGE_ID })
    );
    expect(mockListChannelThreadReplies).not.toHaveBeenCalled();
  });
});

// --- POST thread reply ---------------------------------------------------------
describe('POST /api/channels/[pageId]/messages (thread reply)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalRealtimeUrl = process.env.INTERNAL_REALTIME_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_REALTIME_URL = 'http://realtime.test';
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    mockBroadcastThreadReplyCountUpdated.mockResolvedValue(undefined);
    mockListChannelThreadFollowers.mockResolvedValue([]);
    mockBroadcastInboxEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalRealtimeUrl === undefined) {
      delete process.env.INTERNAL_REALTIME_URL;
    } else {
      process.env.INTERNAL_REALTIME_URL = originalRealtimeUrl;
    }
  });

  it('routes through insertChannelThreadReply when parentId is provided and broadcasts the reply', async () => {
    const replyCreatedAt = new Date('2026-05-04T12:00:00Z');
    mockInsertChannelThreadReply.mockResolvedValueOnce({
      kind: 'ok',
      reply: { id: 'reply-1', createdAt: replyCreatedAt },
      mirror: null,
      rootId: PARENT_ID,
      replyCount: 1,
      lastReplyAt: replyCreatedAt,
    });
    mockLoadChannelMessageWithRelations.mockResolvedValueOnce({
      id: 'reply-1',
      parentId: PARENT_ID,
      pageId: PAGE_ID,
      content: 'in-thread',
      createdAt: replyCreatedAt.toISOString(),
    });

    const res = await callPost({
      content: 'in-thread',
      parentId: PARENT_ID,
    });

    expect(res.status).toBe(201);
    expect(mockInsertChannelThreadReply).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: PARENT_ID,
        pageId: PAGE_ID,
        userId: USER_ID,
        content: 'in-thread',
        alsoSendToParent: false,
      })
    );
    expect(mockInsertChannelMessage).not.toHaveBeenCalled();
    // Replying in a thread is NOT the same as reading the channel — the
    // thread path must NOT upsert channelReadStatus (which would silently
    // mark unread top-level messages as read).
    expect(mockUpsertChannelReadStatus).not.toHaveBeenCalled();

    const broadcasts = captureRealtimeBroadcasts(fetchMock);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].channelId).toBe(PAGE_ID);
    expect(broadcasts[0].event).toBe('new_message');
    const payload = broadcasts[0].payload as Record<string, unknown>;
    expect(payload.parentId).toBe(PARENT_ID);

    expect(mockBroadcastThreadReplyCountUpdated).toHaveBeenCalledWith(
      PAGE_ID,
      expect.objectContaining({
        rootId: PARENT_ID,
        replyCount: 1,
        lastReplyAt: replyCreatedAt.toISOString(),
      })
    );
  });

  it('emits TWO new_message broadcasts (thread reply + mirror) when alsoSendToParent is true', async () => {
    const t = new Date('2026-05-04T12:00:00Z');
    mockInsertChannelThreadReply.mockResolvedValueOnce({
      kind: 'ok',
      reply: { id: 'reply-1', createdAt: t },
      mirror: { id: 'mirror-1', createdAt: t },
      rootId: PARENT_ID,
      replyCount: 1,
      lastReplyAt: t,
    });
    mockLoadChannelMessageWithRelations
      .mockResolvedValueOnce({ id: 'reply-1', parentId: PARENT_ID, content: 'echo' })
      .mockResolvedValueOnce({ id: 'mirror-1', mirroredFromId: 'reply-1', parentId: null, content: 'echo' });

    await callPost({
      content: 'echo',
      parentId: PARENT_ID,
      alsoSendToParent: true,
    });

    const broadcasts = captureRealtimeBroadcasts(fetchMock);
    expect(broadcasts).toHaveLength(2);
    const ids = broadcasts.map((b) => (b.payload as Record<string, unknown>).id).sort();
    expect(ids).toEqual(['mirror-1', 'reply-1']);
    // The mirror has parentId=null and mirroredFromId set; the thread reply has
    // parentId set. Clients dedupe on id — both must appear with distinct ids.
    const mirror = broadcasts.find((b) => (b.payload as Record<string, unknown>).id === 'mirror-1');
    const thread = broadcasts.find((b) => (b.payload as Record<string, unknown>).id === 'reply-1');
    expect((mirror!.payload as Record<string, unknown>).mirroredFromId).toBe('reply-1');
    expect((thread!.payload as Record<string, unknown>).parentId).toBe(PARENT_ID);
  });

  it('returns 404 when the parent does not exist', async () => {
    mockInsertChannelThreadReply.mockResolvedValueOnce({ kind: 'parent_not_found' });

    const res = await callPost({ content: 'x', parentId: 'missing' });

    expect(res.status).toBe(404);
    expect(captureRealtimeBroadcasts(fetchMock)).toHaveLength(0);
  });

  it('returns 400 when the parent belongs to a different channel', async () => {
    mockInsertChannelThreadReply.mockResolvedValueOnce({ kind: 'parent_wrong_page' });

    const res = await callPost({ content: 'x', parentId: 'cross-channel' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when the parent is itself a thread reply (depth-2 attempt)', async () => {
    mockInsertChannelThreadReply.mockResolvedValueOnce({ kind: 'parent_not_top_level' });

    const res = await callPost({ content: 'x', parentId: 'reply-as-parent' });

    expect(res.status).toBe(400);
  });

  it('fans out thread_updated to followers but EXCLUDES the reply author', async () => {
    const replyCreatedAt = new Date('2026-05-04T12:00:00Z');
    mockInsertChannelThreadReply.mockResolvedValueOnce({
      kind: 'ok',
      reply: { id: 'reply-1', createdAt: replyCreatedAt },
      mirror: null,
      rootId: PARENT_ID,
      replyCount: 2,
      lastReplyAt: replyCreatedAt,
    });
    mockLoadChannelMessageWithRelations.mockResolvedValueOnce({
      id: 'reply-1',
      parentId: PARENT_ID,
      pageId: PAGE_ID,
      content: 'in-thread',
      createdAt: replyCreatedAt.toISOString(),
      user: { id: USER_ID, name: 'Sender', image: null },
    });
    mockListChannelThreadFollowers.mockResolvedValueOnce([USER_ID, 'follower-1', 'follower-2']);

    await callPost({ content: 'in-thread', parentId: PARENT_ID });

    const threadUpdatedCalls = mockBroadcastInboxEvent.mock.calls.filter(
      ([, payload]) => (payload as { operation: string }).operation === 'thread_updated'
    );
    const recipients = threadUpdatedCalls.map(([userId]) => userId);
    expect(recipients).toEqual(expect.arrayContaining(['follower-1', 'follower-2']));
    expect(recipients).not.toContain(USER_ID);

    // Each thread_updated payload carries the new contract fields.
    const payload = threadUpdatedCalls[0][1] as {
      operation: string;
      type: string;
      id: string;
      rootMessageId: string;
      lastReplyAt: string;
      lastReplyPreview: string;
      lastReplySender: { id: string; name: string };
    };
    expect(payload.type).toBe('channel');
    expect(payload.id).toBe(PAGE_ID);
    expect(payload.rootMessageId).toBe(PARENT_ID);
    expect(payload.lastReplyAt).toBe(replyCreatedAt.toISOString());
  });

  it('emits channel_updated to a mentioned non-follower who can view the channel', async () => {
    const replyCreatedAt = new Date('2026-05-04T12:00:00Z');
    mockInsertChannelThreadReply.mockResolvedValueOnce({
      kind: 'ok',
      reply: { id: 'reply-1', createdAt: replyCreatedAt },
      mirror: null,
      rootId: PARENT_ID,
      replyCount: 1,
      lastReplyAt: replyCreatedAt,
    });
    mockLoadChannelMessageWithRelations.mockResolvedValueOnce({
      id: 'reply-1',
      parentId: PARENT_ID,
      pageId: PAGE_ID,
      content: 'hey @[Bob](user-bob:user)',
      createdAt: replyCreatedAt.toISOString(),
      user: { id: USER_ID, name: 'Sender', image: null },
    });
    mockListChannelThreadFollowers.mockResolvedValueOnce([USER_ID]);
    const dbModule = (await import('@pagespace/db/db')) as unknown as {
      db: { query: { pages: { findFirst: ReturnType<typeof vi.fn> } } };
    };
    dbModule.db.query.pages.findFirst.mockResolvedValueOnce({
      driveId: 'drive-1',
      title: 'General',
      drive: { ownerId: 'owner-1', name: 'Workspace', slug: 'workspace' },
    });
    // Default canUserViewPage mock returns true, so the mentioned user passes
    // the view-permission gate.
    const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(canUserViewPage).mockResolvedValue(true);

    await callPost({
      content: 'hey @[Bob](user-bob:user)',
      parentId: PARENT_ID,
    });

    const channelUpdatedCalls = mockBroadcastInboxEvent.mock.calls.filter(
      ([, payload]) =>
        (payload as { operation: string; type: string }).operation === 'channel_updated'
    );
    const recipients = channelUpdatedCalls.map(([userId]) => userId);
    expect(recipients).toContain('user-bob');
  });

  it('does NOT fire the targeted mention bump when alsoSendToParent is set (broad fan-out covers everyone)', async () => {
    const replyCreatedAt = new Date('2026-05-04T12:00:00Z');
    mockInsertChannelThreadReply.mockResolvedValueOnce({
      kind: 'ok',
      reply: { id: 'reply-1', createdAt: replyCreatedAt },
      mirror: { id: 'mirror-1', createdAt: replyCreatedAt },
      rootId: PARENT_ID,
      replyCount: 1,
      lastReplyAt: replyCreatedAt,
    });
    mockLoadChannelMessageWithRelations
      .mockResolvedValueOnce({
        id: 'reply-1',
        parentId: PARENT_ID,
        content: 'hey @[Bob](user-bob:user)',
        createdAt: replyCreatedAt.toISOString(),
        user: { id: USER_ID, name: 'Sender', image: null },
      })
      .mockResolvedValueOnce({ id: 'mirror-1', mirroredFromId: 'reply-1', parentId: null });
    mockListChannelThreadFollowers.mockResolvedValueOnce([USER_ID]);

    const dbModule = (await import('@pagespace/db/db')) as unknown as {
      db: {
        query: { pages: { findFirst: ReturnType<typeof vi.fn> } };
        select: ReturnType<typeof vi.fn>;
      };
    };
    dbModule.db.query.pages.findFirst.mockResolvedValueOnce({
      driveId: 'drive-1',
      title: 'General',
      drive: { ownerId: 'owner-1', name: 'Workspace', slug: 'workspace' },
    });

    await callPost({
      content: 'hey @[Bob](user-bob:user)',
      parentId: PARENT_ID,
      alsoSendToParent: true,
    });

    // When alsoSendToParent is set, the mirror's broad fan-out covers viewable
    // members. The targeted mention bump is short-circuited so user-bob does
    // NOT receive two channel_updated payloads for the same underlying event.
    const channelUpdatedCalls = mockBroadcastInboxEvent.mock.calls.filter(
      ([, payload]) => (payload as { operation: string }).operation === 'channel_updated'
    );
    const recipientCounts = channelUpdatedCalls.reduce<Record<string, number>>(
      (acc, [uid]) => {
        const id = uid as string;
        acc[id] = (acc[id] ?? 0) + 1;
        return acc;
      },
      {}
    );
    expect(recipientCounts['user-bob'] ?? 0).toBeLessThanOrEqual(1);
  });

  it('does NOT emit channel_updated to a mentioned user who cannot view the channel', async () => {
    const replyCreatedAt = new Date('2026-05-04T12:00:00Z');
    mockInsertChannelThreadReply.mockResolvedValueOnce({
      kind: 'ok',
      reply: { id: 'reply-1', createdAt: replyCreatedAt },
      mirror: null,
      rootId: PARENT_ID,
      replyCount: 1,
      lastReplyAt: replyCreatedAt,
    });
    mockLoadChannelMessageWithRelations.mockResolvedValueOnce({
      id: 'reply-1',
      parentId: PARENT_ID,
      pageId: PAGE_ID,
      content: 'hey @[Stranger](user-outsider:user)',
      createdAt: replyCreatedAt.toISOString(),
      user: { id: USER_ID, name: 'Sender', image: null },
    });
    mockListChannelThreadFollowers.mockResolvedValueOnce([USER_ID]);
    const dbModule = (await import('@pagespace/db/db')) as unknown as {
      db: { query: { pages: { findFirst: ReturnType<typeof vi.fn> } } };
    };
    dbModule.db.query.pages.findFirst.mockResolvedValueOnce({
      driveId: 'drive-1',
      title: 'General',
      drive: { ownerId: 'owner-1', name: 'Workspace', slug: 'workspace' },
    });
    // Sender (USER_ID) passes; the mentioned outsider does not.
    const { canUserViewPage } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(canUserViewPage).mockImplementation(async (uid) => uid === USER_ID);

    await callPost({
      content: 'hey @[Stranger](user-outsider:user)',
      parentId: PARENT_ID,
    });

    const channelUpdatedCalls = mockBroadcastInboxEvent.mock.calls.filter(
      ([, payload]) =>
        (payload as { operation: string; type: string }).operation === 'channel_updated'
    );
    const recipients = channelUpdatedCalls.map(([uid]) => uid);
    expect(recipients).not.toContain('user-outsider');
  });
});

// --- Existing-behavior preservation -------------------------------------------
describe('POST /api/channels/[pageId]/messages (top-level — existing path)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_REALTIME_URL = 'http://realtime.test';
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    mockInsertChannelMessage.mockResolvedValue({ id: 'msg-1' });
    mockUpsertChannelReadStatus.mockResolvedValue(undefined);
    mockLoadChannelMessageWithRelations.mockResolvedValue({
      id: 'msg-1',
      content: 'hi',
      createdAt: new Date('2026-05-04T12:00:00Z'),
      user: { id: USER_ID, name: 'Test', image: null },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes top-level posts through insertChannelMessage (no thread helper)', async () => {
    const res = await callPost({ content: 'hi' });

    expect(res.status).toBe(201);
    expect(mockInsertChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: PAGE_ID, userId: USER_ID, content: 'hi' })
    );
    expect(mockInsertChannelThreadReply).not.toHaveBeenCalled();
    expect(mockBroadcastThreadReplyCountUpdated).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(authError(401));

    const res = await callPost({ content: 'hi' });

    expect(res.status).toBe(401);
    expect(mockInsertChannelMessage).not.toHaveBeenCalled();
  });
});
