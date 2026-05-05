/**
 * Contract tests for POST /api/messages/[conversationId]
 *
 * These tests verify the Request → Response contract and boundary obligations
 * for sending DMs with optional file attachments. The repository seam
 * (`dmMessageRepository`) is mocked so assertions exercise the route's
 * validation, persistence payload, preview synthesis, and realtime fanout
 * without touching the ORM chain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

// --- Auth boundary --------------------------------------------------------------
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(
    (r: unknown) => typeof r === 'object' && r !== null && 'error' in r
  ),
}));

// --- Email verification gate ---------------------------------------------------
vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  isEmailVerified: vi.fn(),
}));

// --- DM repository seam (the boundary the route must delegate to) --------------
const mockFindConversationForParticipant = vi.fn();
const mockValidateAttachmentForDm = vi.fn();
const mockInsertDmMessage = vi.fn();
const mockUpdateConversationLastMessage = vi.fn();
const mockListActiveMessages = vi.fn();
const mockMarkActiveMessagesRead = vi.fn();
const mockUpdateConversationLastRead = vi.fn();
const mockInsertDmThreadReply = vi.fn();
const mockListDmThreadReplies = vi.fn();
const mockFindActiveMessage = vi.fn();
const mockListDmThreadFollowers = vi.fn();
vi.mock('@pagespace/lib/services/dm-message-repository', () => ({
  dmMessageRepository: {
    findConversationForParticipant: (...args: unknown[]) =>
      mockFindConversationForParticipant(...args),
    validateAttachmentForDm: (...args: unknown[]) =>
      mockValidateAttachmentForDm(...args),
    insertDmMessage: (...args: unknown[]) => mockInsertDmMessage(...args),
    updateConversationLastMessage: (...args: unknown[]) =>
      mockUpdateConversationLastMessage(...args),
    listActiveMessages: (...args: unknown[]) => mockListActiveMessages(...args),
    markActiveMessagesRead: (...args: unknown[]) =>
      mockMarkActiveMessagesRead(...args),
    updateConversationLastRead: (...args: unknown[]) =>
      mockUpdateConversationLastRead(...args),
    insertDmThreadReply: (...args: unknown[]) => mockInsertDmThreadReply(...args),
    listDmThreadReplies: (...args: unknown[]) => mockListDmThreadReplies(...args),
    findActiveMessage: (...args: unknown[]) => mockFindActiveMessage(...args),
    listDmThreadFollowers: (...args: unknown[]) => mockListDmThreadFollowers(...args),
  },
}));

// --- Audit + logger seams ------------------------------------------------------
const mockAuditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    realtime: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  },
}));

// --- Notifications -------------------------------------------------------------
const mockCreateOrUpdateMessageNotification = vi.fn();
vi.mock('@pagespace/lib/notifications/notifications', () => ({
  createOrUpdateMessageNotification: (...args: unknown[]) =>
    mockCreateOrUpdateMessageNotification(...args),
}));

// --- Realtime broadcast helpers ------------------------------------------------
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({ 'x-signed': 'yes' })),
}));

const mockBroadcastInboxEvent = vi.fn();
const mockBroadcastThreadReplyCountUpdated = vi.fn();
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: (...args: unknown[]) => mockBroadcastInboxEvent(...args),
  broadcastThreadReplyCountUpdated: (...args: unknown[]) =>
    mockBroadcastThreadReplyCountUpdated(...args),
}));

// --- Imports under test (must come after vi.mock blocks) -----------------------
import { POST, GET, PATCH } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import type { SessionAuthResult, AuthError } from '@/lib/auth';
import type { AttachmentMeta } from '@pagespace/lib/types';

// --- Fixtures ------------------------------------------------------------------
const SENDER_ID = 'user_sender';
const RECIPIENT_ID = 'user_recipient';
const CONVERSATION_ID = 'conv_1';
const FILE_ID = 'file_abc123';

const sessionAuth = (userId = SENDER_ID): SessionAuthResult => ({
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

const mockConversation = (overrides: Partial<{
  id: string;
  participant1Id: string;
  participant2Id: string;
}> = {}) => ({
  id: overrides.id ?? CONVERSATION_ID,
  participant1Id: overrides.participant1Id ?? SENDER_ID,
  participant2Id: overrides.participant2Id ?? RECIPIENT_ID,
});

const mockInsertedRow = (overrides: Partial<{
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  fileId: string | null;
  attachmentMeta: AttachmentMeta | null;
}> = {}) => ({
  id: overrides.id ?? 'msg_1',
  conversationId: overrides.conversationId ?? CONVERSATION_ID,
  senderId: overrides.senderId ?? SENDER_ID,
  content: overrides.content ?? '',
  fileId: overrides.fileId ?? null,
  attachmentMeta: overrides.attachmentMeta ?? null,
  isRead: false,
  readAt: null,
  isEdited: false,
  editedAt: null,
  isActive: true,
  deletedAt: null,
  createdAt: new Date('2026-05-02T00:00:00Z'),
});

const imageMeta: AttachmentMeta = {
  originalName: 'cat.png',
  size: 12345,
  mimeType: 'image/png',
  contentHash: 'sha256-cat',
};

const pdfMeta: AttachmentMeta = {
  originalName: 'report.pdf',
  size: 67890,
  mimeType: 'application/pdf',
  contentHash: 'sha256-pdf',
};

function makeRequest(body: unknown): Request {
  return new Request(`http://localhost/api/messages/${CONVERSATION_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const callRoute = (body: unknown) =>
  POST(makeRequest(body), {
    params: Promise.resolve({ conversationId: CONVERSATION_ID }),
  });

// --- Default success-path mocks ------------------------------------------------
function setupHappyPath() {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
  vi.mocked(isEmailVerified).mockResolvedValue(true);
  mockFindConversationForParticipant.mockResolvedValue(mockConversation());
  mockValidateAttachmentForDm.mockResolvedValue({ kind: 'ok' });
  mockInsertDmMessage.mockImplementation(async (input) => mockInsertedRow(input));
  mockUpdateConversationLastMessage.mockResolvedValue(undefined);
  mockCreateOrUpdateMessageNotification.mockResolvedValue(undefined);
  mockBroadcastInboxEvent.mockResolvedValue(undefined);
}

// --- Helpers to inspect the realtime broadcast --------------------------------
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

// --- Tests ---------------------------------------------------------------------
describe('POST /api/messages/[conversationId]', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalRealtimeUrl = process.env.INTERNAL_REALTIME_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_REALTIME_URL = 'http://realtime.test';
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setupHappyPath();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalRealtimeUrl === undefined) {
      delete process.env.INTERNAL_REALTIME_URL;
    } else {
      process.env.INTERNAL_REALTIME_URL = originalRealtimeUrl;
    }
  });

  // ===== 1. Body validation =====
  describe('body validation', () => {
    it('persists content and broadcasts it for content-only messages (today\'s behavior)', async () => {
      const res = await callRoute({ content: 'hello world' });

      expect(res.status).toBe(200);
      expect(mockInsertDmMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          senderId: SENDER_ID,
          content: 'hello world',
          fileId: null,
          attachmentMeta: null,
        })
      );
      const broadcasts = captureRealtimeBroadcasts(fetchMock);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].event).toBe('new_dm_message');
      const payload = broadcasts[0].payload as Record<string, unknown>;
      expect(payload.content).toBe('hello world');
      expect(payload.fileId).toBeNull();
    });

    it('persists empty content and the file fields when only fileId+attachmentMeta provided', async () => {
      const res = await callRoute({ fileId: FILE_ID, attachmentMeta: imageMeta });

      expect(res.status).toBe(200);
      expect(mockInsertDmMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: '',
          fileId: FILE_ID,
          attachmentMeta: imageMeta,
        })
      );
      const broadcasts = captureRealtimeBroadcasts(fetchMock);
      expect(broadcasts[0].event).toBe('new_dm_message');
      const payload = broadcasts[0].payload as Record<string, unknown>;
      expect(payload.fileId).toBe(FILE_ID);
      expect(payload.attachmentMeta).toEqual(imageMeta);
    });

    it('persists both content and file fields when caption + attachment are provided', async () => {
      const res = await callRoute({
        content: 'see attached',
        fileId: FILE_ID,
        attachmentMeta: pdfMeta,
      });

      expect(res.status).toBe(200);
      expect(mockInsertDmMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'see attached',
          fileId: FILE_ID,
          attachmentMeta: pdfMeta,
        })
      );
      const broadcasts = captureRealtimeBroadcasts(fetchMock);
      const payload = broadcasts[0].payload as Record<string, unknown>;
      expect(payload.content).toBe('see attached');
      expect(payload.fileId).toBe(FILE_ID);
      expect(payload.attachmentMeta).toEqual(pdfMeta);
    });

    it('returns 400 when both content is empty and no fileId provided', async () => {
      const res = await callRoute({ content: '' });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/content or file is required/i);
      expect(mockInsertDmMessage).not.toHaveBeenCalled();
    });

    it('returns 400 when fileId is provided without attachmentMeta', async () => {
      const res = await callRoute({ fileId: FILE_ID });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/attachmentmeta required when fileid/i);
      expect(mockInsertDmMessage).not.toHaveBeenCalled();
    });

    it('returns 400 when attachmentMeta has the wrong shape', async () => {
      const res = await callRoute({
        fileId: FILE_ID,
        attachmentMeta: { originalName: 'x.png' },
      });

      expect(res.status).toBe(400);
      expect(mockInsertDmMessage).not.toHaveBeenCalled();
    });

    it.each([
      { label: 'missing originalName', meta: { size: 1, mimeType: 'image/png', contentHash: 'h' } },
      { label: 'missing size', meta: { originalName: 'x', mimeType: 'image/png', contentHash: 'h' } },
      { label: 'missing mimeType', meta: { originalName: 'x', size: 1, contentHash: 'h' } },
      { label: 'missing contentHash', meta: { originalName: 'x', size: 1, mimeType: 'image/png' } },
      { label: 'size as string', meta: { originalName: 'x', size: '1', mimeType: 'image/png', contentHash: 'h' } },
      { label: 'attachmentMeta is array', meta: ['not', 'an', 'object'] },
      { label: 'attachmentMeta is string', meta: 'definitely-not-an-object' },
      { label: 'attachmentMeta is number', meta: 42 },
    ])('returns 400 when attachmentMeta is malformed ($label)', async ({ meta }) => {
      const res = await callRoute({ fileId: FILE_ID, attachmentMeta: meta });

      expect(res.status).toBe(400);
      expect(mockInsertDmMessage).not.toHaveBeenCalled();
    });
  });

  // ===== 2. Ownership + linkage =====
  describe('ownership and conversation linkage', () => {
    it('returns 403 + authz.access.denied audit and does not insert when file is not owned by sender', async () => {
      mockValidateAttachmentForDm.mockResolvedValue({ kind: 'wrong_owner' });

      const res = await callRoute({ fileId: FILE_ID, attachmentMeta: imageMeta });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/do not own this file/i);
      expect(mockInsertDmMessage).not.toHaveBeenCalled();
      expect(mockAuditRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventType: 'authz.access.denied',
          userId: SENDER_ID,
          resourceType: 'dm_message',
          resourceId: FILE_ID,
        })
      );
    });

    it('returns 403 + authz.access.denied audit when file is not linked to this conversation (anti-smuggling)', async () => {
      mockValidateAttachmentForDm.mockResolvedValue({ kind: 'not_linked' });

      const res = await callRoute({ fileId: FILE_ID, attachmentMeta: imageMeta });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toMatch(/not linked to this conversation/i);
      expect(mockInsertDmMessage).not.toHaveBeenCalled();
      expect(mockAuditRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventType: 'authz.access.denied',
          userId: SENDER_ID,
          resourceType: 'dm_message',
          resourceId: FILE_ID,
        })
      );
    });

    it('returns 404 when fileId does not exist', async () => {
      mockValidateAttachmentForDm.mockResolvedValue({ kind: 'not_found' });

      const res = await callRoute({ fileId: FILE_ID, attachmentMeta: imageMeta });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/file not found/i);
      expect(mockInsertDmMessage).not.toHaveBeenCalled();
    });
  });

  // ===== 3. Persistence =====
  describe('persistence payload', () => {
    it('inserts the directMessages row with fileId and attachmentMeta and broadcasts it', async () => {
      const inserted = mockInsertedRow({
        fileId: FILE_ID,
        attachmentMeta: imageMeta,
      });
      mockInsertDmMessage.mockResolvedValue(inserted);

      const res = await callRoute({ fileId: FILE_ID, attachmentMeta: imageMeta });

      expect(res.status).toBe(200);
      const responseBody = await res.json();
      expect(responseBody.message).toMatchObject({
        fileId: FILE_ID,
        attachmentMeta: imageMeta,
      });
      const broadcasts = captureRealtimeBroadcasts(fetchMock);
      const payload = broadcasts[0].payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        id: inserted.id,
        fileId: FILE_ID,
        attachmentMeta: imageMeta,
      });
    });
  });

  // ===== 4. Preview synthesis =====
  describe('lastMessagePreview synthesis', () => {
    it('uses [image: name] for image attachments with empty content', async () => {
      await callRoute({ fileId: FILE_ID, attachmentMeta: imageMeta });

      expect(mockUpdateConversationLastMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONVERSATION_ID,
          lastMessagePreview: `[image: ${imageMeta.originalName}]`,
        })
      );
      expect(mockCreateOrUpdateMessageNotification).toHaveBeenCalledWith(
        RECIPIENT_ID,
        CONVERSATION_ID,
        `[image: ${imageMeta.originalName}]`,
        SENDER_ID
      );
    });

    it('uses [file: name] for non-image attachments with empty content', async () => {
      await callRoute({ fileId: FILE_ID, attachmentMeta: pdfMeta });

      expect(mockUpdateConversationLastMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          lastMessagePreview: `[file: ${pdfMeta.originalName}]`,
        })
      );
    });

    it('falls back to the attachment placeholder when caption is whitespace-only', async () => {
      await callRoute({
        content: '   ',
        fileId: FILE_ID,
        attachmentMeta: imageMeta,
      });

      expect(mockUpdateConversationLastMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          lastMessagePreview: `[image: ${imageMeta.originalName}]`,
        })
      );
      expect(mockCreateOrUpdateMessageNotification).toHaveBeenCalledWith(
        RECIPIENT_ID,
        CONVERSATION_ID,
        `[image: ${imageMeta.originalName}]`,
        SENDER_ID
      );
    });

    it('normalizes whitespace-only caption to empty string before persistence and broadcast', async () => {
      mockInsertDmMessage.mockImplementation(async (input) => mockInsertedRow(input));

      await callRoute({
        content: '   \t\n  ',
        fileId: FILE_ID,
        attachmentMeta: imageMeta,
      });

      expect(mockInsertDmMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: '' })
      );
      const broadcasts = captureRealtimeBroadcasts(fetchMock);
      const payload = broadcasts[0].payload as Record<string, unknown>;
      expect(payload.content).toBe('');
    });

    it('prefers content over the attachment placeholder when both are present', async () => {
      await callRoute({
        content: 'caption',
        fileId: FILE_ID,
        attachmentMeta: imageMeta,
      });

      expect(mockUpdateConversationLastMessage).toHaveBeenCalledWith(
        expect.objectContaining({ lastMessagePreview: 'caption' })
      );
    });

    it('truncates content longer than 100 chars with an ellipsis', async () => {
      const long = 'x'.repeat(150);
      await callRoute({ content: long });

      const expected = long.substring(0, 100) + '...';
      expect(mockUpdateConversationLastMessage).toHaveBeenCalledWith(
        expect.objectContaining({ lastMessagePreview: expected })
      );
    });
  });

  // ===== 5. Realtime fanout =====
  describe('realtime fanout', () => {
    it('broadcasts new_dm_message with fileId and attachmentMeta in the payload', async () => {
      const inserted = mockInsertedRow({ fileId: FILE_ID, attachmentMeta: pdfMeta });
      mockInsertDmMessage.mockResolvedValue(inserted);

      await callRoute({ fileId: FILE_ID, attachmentMeta: pdfMeta });

      const broadcasts = captureRealtimeBroadcasts(fetchMock);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].channelId).toBe(`dm:${CONVERSATION_ID}`);
      expect(broadcasts[0].event).toBe('new_dm_message');
      const payload = broadcasts[0].payload as Record<string, unknown>;
      expect(payload.fileId).toBe(FILE_ID);
      expect(payload.attachmentMeta).toEqual(pdfMeta);
    });

    it('includes attachmentMeta in the inbox event payload', async () => {
      await callRoute({ fileId: FILE_ID, attachmentMeta: imageMeta });

      expect(mockBroadcastInboxEvent).toHaveBeenCalledWith(
        RECIPIENT_ID,
        expect.objectContaining({
          operation: 'dm_updated',
          type: 'dm',
          id: CONVERSATION_ID,
          attachmentMeta: imageMeta,
        })
      );
    });
  });

  // ===== 6. Existing-behavior preservation =====
  describe('existing-behavior preservation', () => {
    it('returns 403 when email is unverified', async () => {
      vi.mocked(isEmailVerified).mockResolvedValue(false);

      const res = await callRoute({ content: 'hi' });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.requiresEmailVerification).toBe(true);
      expect(mockInsertDmMessage).not.toHaveBeenCalled();
    });

    it('returns 404 when caller is not a participant', async () => {
      mockFindConversationForParticipant.mockResolvedValue(null);

      const res = await callRoute({ content: 'hi' });

      expect(res.status).toBe(404);
      expect(mockInsertDmMessage).not.toHaveBeenCalled();
    });

    it('returns 401 when unauthenticated', async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(authError(401));

      const res = await callRoute({ content: 'hi' });

      expect(res.status).toBe(401);
      expect(mockInsertDmMessage).not.toHaveBeenCalled();
    });
  });
});

// =====================================================================
// GET / PATCH (mark-as-read) — soft-delete filtering (PR 7)
// =====================================================================

function makeGetRequest(qs = ''): Request {
  return new Request(
    `http://localhost/api/messages/${CONVERSATION_ID}${qs}`,
    { method: 'GET' }
  );
}

function makePatchRequest(): Request {
  return new Request(
    `http://localhost/api/messages/${CONVERSATION_ID}`,
    { method: 'PATCH' }
  );
}

const callGet = (qs = '') =>
  GET(makeGetRequest(qs), {
    params: Promise.resolve({ conversationId: CONVERSATION_ID }),
  });

const callPatch = () =>
  PATCH(makePatchRequest(), {
    params: Promise.resolve({ conversationId: CONVERSATION_ID }),
  });

const liveMessage = (overrides: Partial<{
  id: string;
  senderId: string;
  content: string;
}> = {}) => mockInsertedRow({
  id: overrides.id ?? 'msg_live',
  senderId: overrides.senderId ?? RECIPIENT_ID,
  content: overrides.content ?? 'still here',
});

describe('GET /api/messages/[conversationId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    mockFindConversationForParticipant.mockResolvedValue(mockConversation());
    mockListActiveMessages.mockResolvedValue([]);
    mockMarkActiveMessagesRead.mockResolvedValue(undefined);
    mockUpdateConversationLastRead.mockResolvedValue(undefined);
  });

  it('GET_messages_filtersOutSoftDeleted_byDelegatingToListActiveMessages', async () => {
    // Boundary obligation: the route MUST call the active-only seam, so
    // soft-deleted rows never enter the response payload. The repo is the
    // single point that enforces isActive=true at the SQL layer.
    const live = liveMessage();
    mockListActiveMessages.mockResolvedValue([live]);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(mockListActiveMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        limit: 50,
      })
    );
    const body = await res.json();
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual([live.id]);
  });

  it('GET_messages_withBeforeQuery_passesParsedDate_toListActiveMessages', async () => {
    const before = '2026-04-30T00:00:00.000Z';
    await callGet(`?before=${encodeURIComponent(before)}`);

    expect(mockListActiveMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        before: new Date(before),
      })
    );
  });

  it('GET_messages_withMalformedBefore_returns400_withoutQueryingRepo', async () => {
    // Bad cursor turns into Invalid Date downstream and currently 500s. Reject
    // early with a clean 400 — this is a client error, not a server failure.
    const res = await callGet('?before=not-a-date');

    expect(res.status).toBe(400);
    expect(mockListActiveMessages).not.toHaveBeenCalled();
  });

  it('GET_messages_softDeletedAreNotMarkedRead_byDelegatingToMarkActiveMessagesRead', async () => {
    // The mark-as-read pass must reuse the active-only seam so soft-deleted
    // rows are not silently flipped to isRead=true (which would corrupt unread
    // counts and make a soft-deleted message look like it was acknowledged).
    await callGet();

    expect(mockMarkActiveMessagesRead).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        otherUserId: RECIPIENT_ID,
      })
    );
  });

  it('GET_messages_updatesParticipantLastReadTimestamp_forCallerSide', async () => {
    await callGet();

    expect(mockUpdateConversationLastRead).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        participantSide: 'participant1',
      })
    );
  });

  it('GET_messages_whenNotParticipant_returns404', async () => {
    mockFindConversationForParticipant.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(404);
    expect(mockListActiveMessages).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/messages/[conversationId] (mark-as-read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    mockFindConversationForParticipant.mockResolvedValue(mockConversation());
    mockMarkActiveMessagesRead.mockResolvedValue(undefined);
    mockUpdateConversationLastRead.mockResolvedValue(undefined);
  });

  it('PATCH_markAsRead_skipsSoftDeleted_byDelegatingToMarkActiveMessagesRead', async () => {
    const res = await callPatch();

    expect(res.status).toBe(200);
    expect(mockMarkActiveMessagesRead).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        otherUserId: RECIPIENT_ID,
      })
    );
  });

  it('PATCH_markAsRead_updatesCallerLastReadTimestamp', async () => {
    await callPatch();

    expect(mockUpdateConversationLastRead).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        participantSide: 'participant1',
      })
    );
  });

  it('PATCH_markAsRead_whenNotParticipant_returns404', async () => {
    mockFindConversationForParticipant.mockResolvedValue(null);

    const res = await callPatch();

    expect(res.status).toBe(404);
    expect(mockMarkActiveMessagesRead).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Thread reply support (PR 3)
// =============================================================================

const PARENT_ID = 'parent_dm';

describe('GET /api/messages/[conversationId] (?parentId=)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    mockFindConversationForParticipant.mockResolvedValue(mockConversation());
    // PR 5: GET also fetches followers to populate isFollowing.
    mockListDmThreadFollowers.mockResolvedValue([]);
  });

  it('routes to listDmThreadReplies when ?parentId= is provided and the parent is top-level', async () => {
    mockFindActiveMessage.mockResolvedValueOnce({
      id: PARENT_ID,
      conversationId: CONVERSATION_ID,
      parentId: null,
    });
    mockListDmThreadReplies.mockResolvedValueOnce([]);

    const res = await callGet(`?parentId=${PARENT_ID}`);

    expect(res.status).toBe(200);
    expect(mockListDmThreadReplies).toHaveBeenCalledWith(
      expect.objectContaining({ rootId: PARENT_ID })
    );
    // Top-level list path must not run when threading.
    expect(mockListActiveMessages).not.toHaveBeenCalled();
    // Mark-as-read is for the conversation stream, not the thread panel.
    expect(mockMarkActiveMessagesRead).not.toHaveBeenCalled();
  });

  it('returns 404 when ?parentId= refers to a message not in this conversation', async () => {
    mockFindActiveMessage.mockResolvedValueOnce(null);

    const res = await callGet(`?parentId=${PARENT_ID}`);

    expect(res.status).toBe(404);
    expect(mockListDmThreadReplies).not.toHaveBeenCalled();
  });

  it('returns 400 when ?parentId= refers to a message that is itself a reply (depth-2 fetch)', async () => {
    mockFindActiveMessage.mockResolvedValueOnce({
      id: PARENT_ID,
      conversationId: CONVERSATION_ID,
      parentId: 'some-other-parent',
    });

    const res = await callGet(`?parentId=${PARENT_ID}`);

    expect(res.status).toBe(400);
    expect(mockListDmThreadReplies).not.toHaveBeenCalled();
  });
});

describe('POST /api/messages/[conversationId] (thread reply)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_REALTIME_URL = 'http://realtime.test';
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    vi.mocked(isEmailVerified).mockResolvedValue(true);
    mockFindConversationForParticipant.mockResolvedValue(mockConversation());
    mockBroadcastThreadReplyCountUpdated.mockResolvedValue(undefined);
    mockListDmThreadFollowers.mockResolvedValue([]);
    mockBroadcastInboxEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes through insertDmThreadReply when parentId is provided and broadcasts the reply', async () => {
    const replyCreatedAt = new Date('2026-05-04T12:00:00Z');
    mockInsertDmThreadReply.mockResolvedValueOnce({
      kind: 'ok',
      reply: {
        id: 'reply-1',
        parentId: PARENT_ID,
        conversationId: CONVERSATION_ID,
        senderId: SENDER_ID,
        content: 'in-thread',
        createdAt: replyCreatedAt,
      },
      mirror: null,
      rootId: PARENT_ID,
      replyCount: 1,
      lastReplyAt: replyCreatedAt,
    });

    const res = await callRoute({
      content: 'in-thread',
      parentId: PARENT_ID,
    });

    expect(res.status).toBe(200);
    expect(mockInsertDmThreadReply).toHaveBeenCalledWith(
      expect.objectContaining({
        parentId: PARENT_ID,
        conversationId: CONVERSATION_ID,
        senderId: SENDER_ID,
        content: 'in-thread',
        alsoSendToParent: false,
      })
    );
    expect(mockInsertDmMessage).not.toHaveBeenCalled();
    // No mirror → conversation preview should not bump for the thread-only reply.
    expect(mockUpdateConversationLastMessage).not.toHaveBeenCalled();
    expect(mockCreateOrUpdateMessageNotification).not.toHaveBeenCalled();
    // PR 5: thread-only reply with NO followers (default mock) emits no inbox events.
    // Earlier assertion was "no inbox bumps at all"; now it remains true only because
    // no followers exist — once followers are populated, thread_updated will fan out.
    const dmUpdates = mockBroadcastInboxEvent.mock.calls.filter(
      ([, payload]) => (payload as { operation: string }).operation === 'dm_updated'
    );
    expect(dmUpdates).toHaveLength(0);

    const broadcasts = fetchMock.mock.calls
      .filter(([url]) => typeof url === 'string' && url.includes('/api/broadcast'))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].event).toBe('new_dm_message');
    expect(broadcasts[0].payload.parentId).toBe(PARENT_ID);

    expect(mockBroadcastThreadReplyCountUpdated).toHaveBeenCalledWith(
      `dm:${CONVERSATION_ID}`,
      expect.objectContaining({
        rootId: PARENT_ID,
        replyCount: 1,
        lastReplyAt: replyCreatedAt.toISOString(),
      })
    );
  });

  it('emits TWO new_dm_message broadcasts and bumps the conversation preview when alsoSendToParent is true', async () => {
    const t = new Date('2026-05-04T12:00:00Z');
    mockInsertDmThreadReply.mockResolvedValueOnce({
      kind: 'ok',
      reply: { id: 'reply-1', parentId: PARENT_ID, conversationId: CONVERSATION_ID, senderId: SENDER_ID, content: 'echo', createdAt: t },
      mirror: { id: 'mirror-1', mirroredFromId: 'reply-1', conversationId: CONVERSATION_ID, senderId: SENDER_ID, content: 'echo', createdAt: t },
      rootId: PARENT_ID,
      replyCount: 1,
      lastReplyAt: t,
    });

    await callRoute({
      content: 'echo',
      parentId: PARENT_ID,
      alsoSendToParent: true,
    });

    const broadcasts = fetchMock.mock.calls
      .filter(([url]) => typeof url === 'string' && url.includes('/api/broadcast'))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(broadcasts).toHaveLength(2);
    const ids = broadcasts.map((b) => b.payload.id).sort();
    expect(ids).toEqual(['mirror-1', 'reply-1']);

    // Mirror behaves like a regular top-level send — preview + recipient inbox bump.
    expect(mockUpdateConversationLastMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        lastMessagePreview: 'echo',
      })
    );
    expect(mockBroadcastInboxEvent).toHaveBeenCalledWith(
      RECIPIENT_ID,
      expect.objectContaining({ operation: 'dm_updated', id: CONVERSATION_ID })
    );
  });

  it('returns 404 when the parent does not exist', async () => {
    mockInsertDmThreadReply.mockResolvedValueOnce({ kind: 'parent_not_found' });

    const res = await callRoute({ content: 'x', parentId: 'missing' });

    expect(res.status).toBe(404);
    expect(mockBroadcastThreadReplyCountUpdated).not.toHaveBeenCalled();
  });

  it('returns 400 when the parent belongs to a different conversation', async () => {
    mockInsertDmThreadReply.mockResolvedValueOnce({ kind: 'parent_wrong_conversation' });

    const res = await callRoute({ content: 'x', parentId: 'cross-conv' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when the parent is itself a thread reply (depth-2 attempt)', async () => {
    mockInsertDmThreadReply.mockResolvedValueOnce({ kind: 'parent_not_top_level' });

    const res = await callRoute({ content: 'x', parentId: 'reply-as-parent' });

    expect(res.status).toBe(400);
  });

  it('does NOT emit dm_updated to a mentioned non-participant (sender-controlled IDs cannot leak into other users\' inboxes)', async () => {
    const replyCreatedAt = new Date('2026-05-04T12:00:00Z');
    mockInsertDmThreadReply.mockResolvedValueOnce({
      kind: 'ok',
      reply: {
        id: 'reply-1',
        parentId: PARENT_ID,
        conversationId: CONVERSATION_ID,
        senderId: SENDER_ID,
        content: 'hi @[Outsider](user-outsider:user)',
        createdAt: replyCreatedAt,
      },
      mirror: null,
      rootId: PARENT_ID,
      replyCount: 1,
      lastReplyAt: replyCreatedAt,
    });
    mockListDmThreadFollowers.mockResolvedValueOnce([SENDER_ID]);

    await callRoute({
      content: 'hi @[Outsider](user-outsider:user)',
      parentId: PARENT_ID,
    });

    const dmUpdatedCalls = mockBroadcastInboxEvent.mock.calls.filter(
      ([, payload]) => (payload as { operation: string }).operation === 'dm_updated'
    );
    const recipients = dmUpdatedCalls.map(([uid]) => uid);
    expect(recipients).not.toContain('user-outsider');
  });

  it('fans out thread_updated to DM thread followers but EXCLUDES the reply author', async () => {
    const replyCreatedAt = new Date('2026-05-04T12:00:00Z');
    mockInsertDmThreadReply.mockResolvedValueOnce({
      kind: 'ok',
      reply: {
        id: 'reply-1',
        parentId: PARENT_ID,
        conversationId: CONVERSATION_ID,
        senderId: SENDER_ID,
        content: 'in-thread',
        createdAt: replyCreatedAt,
      },
      mirror: null,
      rootId: PARENT_ID,
      replyCount: 2,
      lastReplyAt: replyCreatedAt,
    });
    mockListDmThreadFollowers.mockResolvedValueOnce([SENDER_ID, RECIPIENT_ID]);

    await callRoute({ content: 'in-thread', parentId: PARENT_ID });

    const threadUpdated = mockBroadcastInboxEvent.mock.calls.filter(
      ([, payload]) => (payload as { operation: string }).operation === 'thread_updated'
    );
    expect(threadUpdated).toHaveLength(1);
    const [recipientId, payload] = threadUpdated[0];
    expect(recipientId).toBe(RECIPIENT_ID);
    expect(recipientId).not.toBe(SENDER_ID);
    const typed = payload as { rootMessageId: string; lastReplyAt: string; lastReplyPreview: string };
    expect(typed.rootMessageId).toBe(PARENT_ID);
    expect(typed.lastReplyAt).toBe(replyCreatedAt.toISOString());
    expect(typeof typed.lastReplyPreview).toBe('string');
    expect(typed.lastReplyPreview.length).toBeGreaterThan(0);
  });

  it('does not emit thread_updated when the DM thread has zero followers, but still completes the reply-count bump', async () => {
    const replyCreatedAt = new Date('2026-05-04T12:00:00Z');
    mockInsertDmThreadReply.mockResolvedValueOnce({
      kind: 'ok',
      reply: {
        id: 'reply-1',
        parentId: PARENT_ID,
        conversationId: CONVERSATION_ID,
        senderId: SENDER_ID,
        content: 'lonely-reply',
        createdAt: replyCreatedAt,
      },
      mirror: null,
      rootId: PARENT_ID,
      replyCount: 1,
      lastReplyAt: replyCreatedAt,
    });
    mockListDmThreadFollowers.mockResolvedValueOnce([]);

    const res = await callRoute({ content: 'lonely-reply', parentId: PARENT_ID });

    // DM thread-reply path returns 200 (channel returns 201) — the two routes
    // diverge here intentionally; do not "fix" the asymmetry without checking
    // both route handlers.
    expect(res.status).toBe(200);
    const threadUpdated = mockBroadcastInboxEvent.mock.calls.filter(
      ([, payload]) => (payload as { operation: string }).operation === 'thread_updated'
    );
    expect(threadUpdated).toHaveLength(0);
    expect(mockBroadcastThreadReplyCountUpdated).toHaveBeenCalledWith(
      `dm:${CONVERSATION_ID}`,
      expect.objectContaining({
        rootId: PARENT_ID,
        replyCount: 1,
        lastReplyAt: replyCreatedAt.toISOString(),
      })
    );
  });
});
