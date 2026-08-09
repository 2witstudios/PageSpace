/**
 * Contract tests for /api/ai/chat/messages/[messageId]/undo
 *
 * Tests both GET (preview) and POST (execute) handlers:
 * - Authentication: 401 for unauthenticated
 * - Authorization: 403 when user can't edit page
 * - Not found: 404 when message doesn't exist
 * - Validation: 400 for invalid mode
 * - Success: 200 with preview/result data
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GET, POST } from '../route';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Mock service boundary
vi.mock('@/services/api', () => ({
  previewAiUndo: vi.fn(),
  executeAiUndo: vi.fn(),
}));

// Mock auth
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result) => 'error' in result),
  checkMCPPageScope: vi.fn(),
  canPrincipalEditPage: vi.fn(async (auth: { userId: string }, pageId: string) => {
    const { canUserEditPage } = await import('@pagespace/lib/permissions/permissions');
    return canUserEditPage(auth.userId, pageId);
  }),
}));

// Mock repository
vi.mock('@/lib/repositories/global-conversation-repository', () => ({
  globalConversationRepository: {
    getConversationById: vi.fn(),
  },
}));

// Mock permissions
// The ONE conversation-access predicate, stubbed at its module boundary — the
// same seam the revs-route and plan-route suites use, since it reaches its
// permission dependency through a package-relative import a consumer's
// `vi.mock` cannot intercept. What this suite proves is DELEGATION: that undo
// asks it, and asks about the right conversation.
vi.mock('@pagespace/lib/permissions/conversation-access', () => ({
  canAccessConversation: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
    canUserEditPage: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
    auditRequest: vi.fn(),
}));

// Mock websocket broadcasts
vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn((driveId, pageId, type, data) => ({
    driveId,
    pageId,
    type,
    ...data,
  })),
}));

// Mock logging mask
vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id) => `***${id.slice(-4)}`),
}));

import { previewAiUndo, executeAiUndo, type AiUndoPreview } from '@/services/api';
import { authenticateRequestWithOptions, checkMCPPageScope } from '@/lib/auth';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions';
import { canAccessConversation } from '@pagespace/lib/permissions/conversation-access';

const mockAuth = vi.mocked(authenticateRequestWithOptions);
const mockCheckMCPPageScope = vi.mocked(checkMCPPageScope);
const mockPreviewAiUndo = vi.mocked(previewAiUndo);
const mockExecuteAiUndo = vi.mocked(executeAiUndo);
const mockCanUserEditPage = vi.mocked(canUserEditPage);
const mockCanAccessConversation = vi.mocked(canAccessConversation);
const mockGlobalConvRepo = vi.mocked(globalConversationRepository);

// Test helpers
const mockUserId = 'user_123';
const mockMessageId = 'msg_123';
const mockPageId = 'page_123';
const mockDriveId = 'drive_123';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

const createGetRequest = () => {
  return new Request(`https://example.com/api/ai/chat/messages/${mockMessageId}/undo`, {
    method: 'GET',
  });
};

const createPostRequest = (body: object) => {
  return new Request(`https://example.com/api/ai/chat/messages/${mockMessageId}/undo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

const createActionPreview = (
  overrides: Partial<AiUndoPreview['activitiesAffected'][number]['preview']> = {}
): AiUndoPreview['activitiesAffected'][number]['preview'] => ({
  action: 'rollback',
  canExecute: true,
  reason: undefined,
  warnings: [],
  hasConflict: false,
  conflictFields: [],
  requiresForce: false,
  isNoOp: false,
  currentValues: null,
  targetValues: null,
  changes: [],
  affectedResources: [],
  ...overrides,
});

const createAiUndoActivity = (
  overrides: Partial<AiUndoPreview['activitiesAffected'][number]> = {}
): AiUndoPreview['activitiesAffected'][number] => ({
  id: 'act_1',
  operation: 'update',
  resourceType: 'page',
  resourceId: mockPageId,
  resourceTitle: 'Test Page',
  pageId: mockPageId,
  driveId: mockDriveId,
  preview: createActionPreview(),
  ...overrides,
});

const createAiUndoPreview = (overrides: Partial<AiUndoPreview> = {}): AiUndoPreview => ({
  messageId: mockMessageId,
  conversationId: 'conv_123',
  pageId: mockPageId,
  // The conversation's own facts, which the route hands to the shared
  // predicate. Owned by the caller and private, i.e. the ordinary case.
  conversationAccess: { userId: mockUserId, isShared: false, type: 'page', contextId: mockPageId },
  driveId: mockDriveId,
  source: 'page_chat',
  createdAt: new Date('2024-01-15'),
  messagesAffected: 0,
  activitiesAffected: [],
  warnings: [],
  ...overrides,
});

const mockParams = Promise.resolve({ messageId: mockMessageId });

describe('GET /api/ai/chat/messages/[messageId]/undo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(mockWebAuth(mockUserId));
    mockCheckMCPPageScope.mockResolvedValue(null); // MCP scope check passes
    mockPreviewAiUndo.mockResolvedValue(createAiUndoPreview());
    mockCanUserEditPage.mockResolvedValue(true);
    mockCanAccessConversation.mockResolvedValue(true);
    mockGlobalConvRepo.getConversationById.mockResolvedValue({ id: 'conv_123' } as never);
  });

  // ============================================
  // Authentication
  // ============================================

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockAuth.mockResolvedValue(mockAuthError(401));

      const response = await GET(createGetRequest(), { params: mockParams });

      expect(response.status).toBe(401);
      expect(previewAiUndo).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Not Found
  // ============================================

  describe('not found', () => {
    it('returns 404 when message does not exist or preview fails', async () => {
      mockPreviewAiUndo.mockResolvedValue(null);

      const response = await GET(createGetRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('Message not found or preview failed');
    });
  });

  // ============================================
  // Authorization
  // ============================================

  describe('authorization', () => {
    it('returns 403 when user lacks edit permission on page', async () => {
      mockCanUserEditPage.mockResolvedValue(false);

      const response = await GET(createGetRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('do not have permission');
    });

    it('returns 403 when user lacks ownership of global conversation', async () => {
      mockPreviewAiUndo.mockResolvedValue(createAiUndoPreview({
        source: 'global_chat',
        conversationId: 'global_conv_123',
        pageId: null,
        driveId: null,
      }));
      mockGlobalConvRepo.getConversationById.mockResolvedValue(null);

      const response = await GET(createGetRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('do not have permission');
    });

    /**
     * THE CONVERSATION GATE (review finding — MAJOR).
     *
     * This branch used to check `canPrincipalEditPage` and nothing else, while
     * the undo sweep is scoped by `conversationId` alone — so any drive member
     * with EDIT on a shared agent page could undo another member's PRIVATE
     * conversation on that page. Note the shape of the two tests above: the
     * GLOBAL branch was checked for ownership and the PAGE branch only for
     * page permission. They pinned the asymmetry rather than catching it.
     *
     * Fails on the pre-fix route, which returned 200.
     */
    it('returns 403 for a page conversation the caller may NOT access, even with edit on the page', async () => {
      mockCanUserEditPage.mockResolvedValue(true);
      mockCanAccessConversation.mockResolvedValue(false);
      mockPreviewAiUndo.mockResolvedValue(createAiUndoPreview({
        // Another member's private thread on a page this caller can edit.
        conversationAccess: { userId: 'someone_else', isShared: false, type: 'page', contextId: mockPageId },
      }));

      const response = await GET(createGetRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('do not have permission');
      // Refused on the conversation, so the page gate is never even consulted.
      expect(mockCanUserEditPage).not.toHaveBeenCalled();
    });

    it('asks the shared predicate about the conversation the undo would sweep', async () => {
      await GET(createGetRequest(), { params: mockParams });

      // Delegation, and with the whole row it decides on — a route passing only
      // the owner could not express "shared AND page access" at all, which is
      // how this came to answer differently from every other conversation gate.
      expect(mockCanAccessConversation).toHaveBeenCalledWith(
        mockUserId,
        expect.objectContaining({ userId: mockUserId, isShared: false, type: 'page', contextId: mockPageId }),
      );
    });

    it('still requires page EDIT once the conversation gate passes — both gates apply', async () => {
      mockCanAccessConversation.mockResolvedValue(true);
      mockCanUserEditPage.mockResolvedValue(false);

      const response = await GET(createGetRequest(), { params: mockParams });

      // Undo rolls page activities back, so access to the thread is not on its
      // own a licence to mutate the page.
      expect(response.status).toBe(403);
    });

    it('denies when the message has no conversation row at all — no row is not shared', async () => {
      mockPreviewAiUndo.mockResolvedValue(createAiUndoPreview({ conversationAccess: null }));
      mockCanAccessConversation.mockResolvedValue(false);

      const response = await GET(createGetRequest(), { params: mockParams });

      expect(response.status).toBe(403);
      expect(mockCanAccessConversation).toHaveBeenCalledWith(
        mockUserId,
        expect.objectContaining({ userId: '', isShared: false }),
      );
    });

    /**
     * A `type='drive'` conversation names no page (its `contextId` is a DRIVE),
     * so it reaches the page branch — `source` is "anything not global" — with
     * `pageId: null`. That used to be a 500, which reads as a server fault for
     * what is really "this verb does not apply here" (review finding — MINOR).
     */
    it('404s a conversation that names no page, rather than 500ing', async () => {
      mockPreviewAiUndo.mockResolvedValue(createAiUndoPreview({
        pageId: null,
        conversationAccess: { userId: mockUserId, isShared: false, type: 'drive', contextId: 'drv_1' },
      }));

      const response = await GET(createGetRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toContain('does not support undo');
    });
  });

  // ============================================
  // Success
  // ============================================

  describe('success', () => {
    it('returns preview data', async () => {
      const mockPreview = createAiUndoPreview({
        messagesAffected: 5,
        activitiesAffected: [
          createAiUndoActivity({ id: 'act_1' }),
        ],
      });

      mockPreviewAiUndo.mockResolvedValue(mockPreview);

      const response = await GET(createGetRequest(), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.messagesAffected).toBe(5);
      expect(body.activitiesAffected).toHaveLength(1);
    });
  });
});

describe('POST /api/ai/chat/messages/[messageId]/undo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue(mockWebAuth(mockUserId));
    mockCheckMCPPageScope.mockResolvedValue(null); // MCP scope check passes
    mockPreviewAiUndo.mockResolvedValue(createAiUndoPreview());
    mockCanUserEditPage.mockResolvedValue(true);
    mockCanAccessConversation.mockResolvedValue(true);
    mockGlobalConvRepo.getConversationById.mockResolvedValue({ id: 'conv_123' } as never);
  });

  // ============================================
  // Authentication
  // ============================================

  describe('authentication', () => {
    it('returns 401 when user is not authenticated', async () => {
      mockAuth.mockResolvedValue(mockAuthError(401));

      const response = await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });

      expect(response.status).toBe(401);
      expect(executeAiUndo).not.toHaveBeenCalled();
    });

    it('requires CSRF token', async () => {
      await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST' }),
        expect.objectContaining({ requireCSRF: true })
      );
    });
  });

  // ============================================
  // Validation
  // ============================================

  describe('validation', () => {
    it('returns 400 for invalid mode', async () => {
      const response = await POST(createPostRequest({ mode: 'invalid' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.error).toContain('messages_only');
      expect(body.error).toContain('messages_and_changes');
    });

    it('returns 400 when mode is missing', async () => {
      const response = await POST(createPostRequest({}), { params: mockParams });

      expect(response.status).toBe(400);
    });

    it('accepts messages_only mode', async () => {
      mockExecuteAiUndo.mockResolvedValue({
        success: true,
        messagesDeleted: 3,
        activitiesRolledBack: 0,
        errors: [],
      });

      const response = await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });

      expect(response.status).toBe(200);
      // Route passes preview to avoid redundant computation
      expect(executeAiUndo).toHaveBeenCalledWith(
        mockMessageId,
        mockUserId,
        'messages_only',
        expect.objectContaining({
          source: 'page_chat',
          pageId: mockPageId,
          messagesAffected: 0,
          activitiesAffected: [],
        }),
        expect.objectContaining({ force: false })
      );
    });

    it('accepts messages_and_changes mode', async () => {
      mockExecuteAiUndo.mockResolvedValue({
        success: true,
        messagesDeleted: 3,
        activitiesRolledBack: 2,
        errors: [],
      });

      const response = await POST(createPostRequest({ mode: 'messages_and_changes' }), { params: mockParams });

      expect(response.status).toBe(200);
      // Route passes preview to avoid redundant computation
      expect(executeAiUndo).toHaveBeenCalledWith(
        mockMessageId,
        mockUserId,
        'messages_and_changes',
        expect.objectContaining({
          source: 'page_chat',
          pageId: mockPageId,
          messagesAffected: 0,
          activitiesAffected: [],
        }),
        expect.objectContaining({ force: false })
      );
    });
  });

  // ============================================
  // Force flag
  // ============================================

  describe('force flag', () => {
    it('forwards force: true to executeAiUndo', async () => {
      mockExecuteAiUndo.mockResolvedValue({
        success: true,
        messagesDeleted: 3,
        activitiesRolledBack: 1,
        errors: [],
      });

      const response = await POST(
        createPostRequest({ mode: 'messages_and_changes', force: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(200);
      expect(executeAiUndo).toHaveBeenCalledWith(
        mockMessageId,
        mockUserId,
        'messages_and_changes',
        expect.objectContaining({
          source: 'page_chat',
          pageId: mockPageId,
          messagesAffected: 0,
          activitiesAffected: [],
        }),
        expect.objectContaining({ force: true })
      );
    });

    it('still enforces auth when force: true', async () => {
      mockAuth.mockResolvedValue(mockAuthError(401));

      const response = await POST(
        createPostRequest({ mode: 'messages_and_changes', force: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(401);
      expect(executeAiUndo).not.toHaveBeenCalled();
    });

    it('forwards force: true even when preview has conflicts', async () => {
      mockPreviewAiUndo.mockResolvedValue(createAiUndoPreview({
        activitiesAffected: [
          createAiUndoActivity({
            preview: createActionPreview({ hasConflict: true, requiresForce: true }),
          }),
        ],
      }));
      mockExecuteAiUndo.mockResolvedValue({
        success: true,
        messagesDeleted: 2,
        activitiesRolledBack: 1,
        errors: [],
      });

      const response = await POST(
        createPostRequest({ mode: 'messages_and_changes', force: true }),
        { params: mockParams }
      );

      expect(response.status).toBe(200);
      expect(executeAiUndo).toHaveBeenCalledWith(
        mockMessageId,
        mockUserId,
        'messages_and_changes',
        expect.objectContaining({
          activitiesAffected: expect.arrayContaining([
            expect.objectContaining({
              preview: expect.objectContaining({ hasConflict: true }),
            }),
          ]),
        }),
        expect.objectContaining({ force: true })
      );
    });
  });

  // ============================================
  // Authorization
  // ============================================

  describe('authorization', () => {
    it('returns 403 when user lacks edit permission', async () => {
      mockCanUserEditPage.mockResolvedValue(false);

      const response = await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(403);
      expect(body.error).toContain('do not have permission');
    });
  });

  // ============================================
  // Success
  // ============================================

  describe('success', () => {
    it('returns success for messages_only mode', async () => {
      mockExecuteAiUndo.mockResolvedValue({
        success: true,
        messagesDeleted: 5,
        activitiesRolledBack: 0,
        errors: [],
      });

      const response = await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.messagesDeleted).toBe(5);
      expect(body.message).toContain('Deleted 5 messages');
    });

    it('returns success for messages_and_changes mode', async () => {
      mockExecuteAiUndo.mockResolvedValue({
        success: true,
        messagesDeleted: 3,
        activitiesRolledBack: 2,
        errors: [],
      });

      const response = await POST(createPostRequest({ mode: 'messages_and_changes' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.message).toContain('Deleted 3 messages');
      expect(body.message).toContain('undid 2 changes');
    });
  });

  describe('failure', () => {
    it('returns 500 when operations fail', async () => {
      mockExecuteAiUndo.mockResolvedValue({
        success: false,
        messagesDeleted: 0,
        activitiesRolledBack: 0,
        errors: ['Complete failure'],
      });

      const response = await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.message).toBe('Undo failed. No changes were applied.');
    });

    it('returns 500 when operations fail with empty errors array', async () => {
      mockExecuteAiUndo.mockResolvedValue({
        success: false,
        messagesDeleted: 0,
        activitiesRolledBack: 0,
        errors: [],
      });

      const response = await POST(createPostRequest({ mode: 'messages_only' }), { params: mockParams });
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.message).toBe('Undo failed. No changes were applied.');
    });
  });
});
