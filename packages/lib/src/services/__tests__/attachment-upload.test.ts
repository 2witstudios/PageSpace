import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDmConversationsFindFirst = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      dmConversations: {
        findFirst: (...args: unknown[]) => mockDmConversationsFindFirst(...args),
      },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: string, value: unknown) => ({ field, value })),
}));
vi.mock('@pagespace/db/schema/social', () => ({
  dmConversations: { id: 'dm_conversations.id' },
}));

const mockCreateUploadServiceToken = vi.fn();
vi.mock('../validated-service-token', () => {
  // Re-define the error class within the mock so we don't trigger loading the real module's
  // transitive @pagespace/db/schema/core dependency. The class shape matches the real one
  // (code === 'PERMISSION_DENIED'), so isPermissionDeniedError still works on instances.
  class PermissionDeniedError extends Error {
    readonly code = 'PERMISSION_DENIED' as const;
    constructor(message: string) {
      super(message);
      this.name = 'PermissionDeniedError';
    }
  }
  function isPermissionDeniedError(error: unknown): error is PermissionDeniedError {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code: unknown }).code === 'PERMISSION_DENIED'
    );
  }
  return {
    createUploadServiceToken: (...args: unknown[]) => mockCreateUploadServiceToken(...args),
    PermissionDeniedError,
    isPermissionDeniedError,
  };
});

const mockCreateSession = vi.fn().mockResolvedValue('ps_svc_conversation-token');
vi.mock('../../auth/session-service', () => ({
  sessionService: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
  },
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import {
  createAttachmentUploadServiceToken,
  type AttachmentTarget,
} from '../attachment-upload';
import { PermissionDeniedError, isPermissionDeniedError } from '../validated-service-token';
import { loggers } from '../../logging/logger-config';

describe('createAttachmentUploadServiceToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateUploadServiceToken.mockResolvedValue({
      token: 'ps_svc_page-token',
      grantedScopes: ['files:write'],
    });
    mockCreateSession.mockResolvedValue('ps_svc_conversation-token');
  });

  describe('page target', () => {
    it('mints token identical to current channel flow by delegating to createUploadServiceToken', async () => {
      // Arrange
      const target: AttachmentTarget = {
        type: 'page',
        pageId: 'page-1',
        driveId: 'drive-1',
      };

      // Act
      const result = await createAttachmentUploadServiceToken({
        userId: 'user-1',
        target,
      });

      // Assert — delegates to the same function the channel route uses today,
      // with parentId === pageId so permission is checked at page level (matching
      // the current channel route behavior at apps/web/src/app/api/channels/[pageId]/upload/route.ts:127-144).
      expect(mockCreateUploadServiceToken).toHaveBeenCalledTimes(1);
      expect(mockCreateUploadServiceToken).toHaveBeenCalledWith({
        userId: 'user-1',
        driveId: 'drive-1',
        pageId: 'page-1',
        parentId: 'page-1',
      });
      expect(result.token).toBe('ps_svc_page-token');
      // Conversation path must not run
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockDmConversationsFindFirst).not.toHaveBeenCalled();
    });

    it('propagates PermissionDeniedError from underlying createUploadServiceToken', async () => {
      mockCreateUploadServiceToken.mockRejectedValue(new PermissionDeniedError('Permission denied'));

      await expect(
        createAttachmentUploadServiceToken({
          userId: 'user-1',
          target: { type: 'page', pageId: 'page-1', driveId: 'drive-1' },
        })
      ).rejects.toSatisfy((error: unknown) => isPermissionDeniedError(error));
    });
  });

  describe('conversation target — participant validation', () => {
    it('mints conversation-bound token when caller is participant1', async () => {
      // Arrange — caller is participant1 of the conversation
      mockDmConversationsFindFirst.mockResolvedValue({
        id: 'conv-1',
        participant1Id: 'user-1',
        participant2Id: 'user-2',
      });

      // Act
      const result = await createAttachmentUploadServiceToken({
        userId: 'user-1',
        target: { type: 'conversation', conversationId: 'conv-1' },
      });

      // Assert — mints a session token bound to the conversation,
      // with NO driveId (DM files have no drive).
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          type: 'service',
          scopes: ['files:write'],
          resourceType: 'conversation',
          resourceId: 'conv-1',
        })
      );
      const passed = mockCreateSession.mock.calls[0][0] as { driveId?: unknown };
      expect(passed.driveId).toBeUndefined();
      expect(result.token).toBe('ps_svc_conversation-token');
      // Page path must not run
      expect(mockCreateUploadServiceToken).not.toHaveBeenCalled();
    });

    it('mints conversation-bound token when caller is participant2', async () => {
      mockDmConversationsFindFirst.mockResolvedValue({
        id: 'conv-1',
        participant1Id: 'user-other',
        participant2Id: 'user-1',
      });

      const result = await createAttachmentUploadServiceToken({
        userId: 'user-1',
        target: { type: 'conversation', conversationId: 'conv-1' },
      });

      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          resourceType: 'conversation',
          resourceId: 'conv-1',
        })
      );
      expect(result.token).toBe('ps_svc_conversation-token');
    });

    it('throws PermissionDeniedError when caller is not a participant', async () => {
      mockDmConversationsFindFirst.mockResolvedValue({
        id: 'conv-1',
        participant1Id: 'user-A',
        participant2Id: 'user-B',
      });

      await expect(
        createAttachmentUploadServiceToken({
          userId: 'user-outsider',
          target: { type: 'conversation', conversationId: 'conv-1' },
        })
      ).rejects.toBeInstanceOf(PermissionDeniedError);

      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Upload token denied: not a conversation participant',
        expect.objectContaining({ userId: 'user-outsider', conversationId: 'conv-1' })
      );
    });

    it('throws PermissionDeniedError when conversation does not exist', async () => {
      mockDmConversationsFindFirst.mockResolvedValue(undefined);

      await expect(
        createAttachmentUploadServiceToken({
          userId: 'user-1',
          target: { type: 'conversation', conversationId: 'missing-conv' },
        })
      ).rejects.toBeInstanceOf(PermissionDeniedError);

      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Upload token denied: conversation not found',
        expect.objectContaining({ userId: 'user-1', conversationId: 'missing-conv' })
      );
    });
  });

  describe('audit logging', () => {
    it('emits scope grant log including target type for page target', async () => {
      await createAttachmentUploadServiceToken({
        userId: 'user-1',
        target: { type: 'page', pageId: 'page-1', driveId: 'drive-1' },
      });

      expect(loggers.api.info).toHaveBeenCalledWith(
        'Attachment upload token grant',
        expect.objectContaining({
          userId: 'user-1',
          targetType: 'page',
        })
      );
    });

    it('emits scope grant log including target type for conversation target', async () => {
      mockDmConversationsFindFirst.mockResolvedValue({
        id: 'conv-1',
        participant1Id: 'user-1',
        participant2Id: 'user-2',
      });

      await createAttachmentUploadServiceToken({
        userId: 'user-1',
        target: { type: 'conversation', conversationId: 'conv-1' },
      });

      expect(loggers.api.info).toHaveBeenCalledWith(
        'Attachment upload token grant',
        expect.objectContaining({
          userId: 'user-1',
          targetType: 'conversation',
        })
      );
    });
  });

  describe('runtime exhaustiveness guard', () => {
    it('throws when an unknown target type is passed (defensive runtime check)', async () => {
      // Force an invalid target through the type system to exercise the default branch.
      const badTarget = { type: 'whatever', conversationId: 'x' } as unknown as AttachmentTarget;

      await expect(
        createAttachmentUploadServiceToken({ userId: 'user-1', target: badTarget })
      ).rejects.toThrow(/unknown attachment target type/i);
    });
  });
});
