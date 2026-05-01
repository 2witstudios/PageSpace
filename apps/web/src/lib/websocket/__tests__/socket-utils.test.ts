/**
 * socket-utils Tests
 * Tests for broadcast functions and channel routing
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock the dependencies
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn((body: string) => ({
    'Content-Type': 'application/json',
    'X-Broadcast-Signature': `t=1234567890,v1=mocksignature_${body.length}`,
  })),
}));

vi.mock('@pagespace/lib/logging/logger-browser', () => ({
  browserLoggers: {
    realtime: {
      child: vi.fn(() => ({
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      })),
    },
  },
}));

vi.mock('@pagespace/lib/utils/environment', () => ({
  isNodeEnvironment: vi.fn(() => true),
}));

vi.mock('@/lib/logging/mask', () => ({
  maskIdentifier: vi.fn((id: string) => `***${id.slice(-4)}`),
}));

// Import after mocks
import {
  broadcastPageEvent,
  broadcastDriveEvent,
  broadcastDriveMemberEvent,
  broadcastTaskEvent,
  broadcastUsageEvent,
  broadcastAiStreamStart,
  broadcastChatUserMessage,
  broadcastAiMessageEdited,
  broadcastAiMessageDeleted,
  type ChatUserMessagePayload,
  type ChatMessageEditedPayload,
  type ChatMessageDeletedPayload,
  broadcastAiStreamComplete,
  createPageEventPayload,
  createDriveEventPayload,
  createDriveMemberEventPayload,
  type PageEventPayload,
  type DriveEventPayload,
  type DriveMemberEventPayload,
  type TaskEventPayload,
  type UsageEventPayload,
  type AiStreamStartPayload,
  type AiStreamCompletePayload,
} from '../socket-utils';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';

describe('socket-utils', () => {
  const originalEnv = process.env;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
    mockFetch.mockResolvedValue({ ok: true });

    // Set up environment with realtime URL
    process.env = {
      ...originalEnv,
      INTERNAL_REALTIME_URL: 'http://localhost:3001',
      NODE_ENV: 'test',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('broadcastPageEvent', () => {
    it('given valid payload, should POST to /api/broadcast with signed headers', async () => {
      const payload: PageEventPayload = {
        driveId: 'drive-123',
        pageId: 'page-456',
        operation: 'created',
        title: 'New Page',
      };

      await broadcastPageEvent(payload);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/api/broadcast',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Broadcast-Signature': expect.stringMatching(/^t=\d+,v1=/),
          }),
        })
      );
    });

    it('given page event, should route to drive:{driveId} channel', async () => {
      const payload: PageEventPayload = {
        driveId: 'drive-123',
        pageId: 'page-456',
        operation: 'updated',
      };

      await broadcastPageEvent(payload);

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);

      expect(requestBody.channelId).toBe('drive:drive-123');
      expect(requestBody.event).toBe('page:updated');
    });

    it('given no INTERNAL_REALTIME_URL, should not call fetch', async () => {
      process.env.INTERNAL_REALTIME_URL = '';

      const payload: PageEventPayload = {
        driveId: 'drive-123',
        pageId: 'page-456',
        operation: 'created',
      };

      await broadcastPageEvent(payload);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('given fetch throws error, should not throw (silent failure)', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const payload: PageEventPayload = {
        driveId: 'drive-123',
        pageId: 'page-456',
        operation: 'deleted',
      };

      await expect(broadcastPageEvent(payload)).resolves.not.toThrow();
    });
  });

  describe('broadcastDriveEvent', () => {
    it('given drive event with recipients, should route to each user channel', async () => {
      const payload: DriveEventPayload = {
        driveId: 'drive-123',
        operation: 'created',
        name: 'New Drive',
      };
      const recipientUserIds = ['user-1', 'user-2'];

      await broadcastDriveEvent(payload, recipientUserIds);

      expect(mockFetch).toHaveBeenCalledTimes(2);

      const firstCall = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(firstCall.channelId).toBe('user:user-1:drives');
      expect(firstCall.event).toBe('drive:created');
      expect(firstCall.payload).toEqual(payload);

      const secondCall = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(secondCall.channelId).toBe('user:user-2:drives');
    });

    it('given no INTERNAL_REALTIME_URL, should not call fetch', async () => {
      process.env.INTERNAL_REALTIME_URL = '';

      const payload: DriveEventPayload = {
        driveId: 'drive-123',
        operation: 'deleted',
      };

      await broadcastDriveEvent(payload, ['user-1']);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('given empty recipients, should not call fetch', async () => {
      const payload: DriveEventPayload = {
        driveId: 'drive-123',
        operation: 'deleted',
      };

      await broadcastDriveEvent(payload, []);

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('broadcastDriveMemberEvent', () => {
    it('given member event, should route to user:{userId}:drives channel', async () => {
      const payload: DriveMemberEventPayload = {
        driveId: 'drive-123',
        userId: 'user-456',
        operation: 'member_added',
        role: 'MEMBER',
      };

      await broadcastDriveMemberEvent(payload);

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);

      expect(requestBody.channelId).toBe('user:user-456:drives');
      expect(requestBody.event).toBe('drive:member_added');
    });
  });

  describe('broadcastTaskEvent', () => {
    it('given task event, should route to user:{userId}:tasks channel', async () => {
      const payload: TaskEventPayload = {
        type: 'task_added',
        userId: 'user-789',
        taskId: 'task-123',
        pageId: 'page-456',
        data: { title: 'New Task' },
      };

      await broadcastTaskEvent(payload);

      const channelIds = mockFetch.mock.calls.map((call) => JSON.parse(call[1].body).channelId);
      expect(channelIds).toContain('user:user-789:tasks');
      const userCallBody = JSON.parse(
        mockFetch.mock.calls.find((call) => JSON.parse(call[1].body).channelId === 'user:user-789:tasks')![1].body
      );
      expect(userCallBody.event).toBe('task:task_added');
    });

    it('given payload with pageId, should fan out to BOTH user:{userId}:tasks and pageId channels', async () => {
      const payload: TaskEventPayload = {
        type: 'task_updated',
        userId: 'user-789',
        taskId: 'task-123',
        pageId: 'page-456',
        data: { title: 'Updated Task' },
      };

      await broadcastTaskEvent(payload);

      expect(mockFetch).toHaveBeenCalledTimes(2);

      const bodies = mockFetch.mock.calls.map((call) => JSON.parse(call[1].body));
      const channelIds = bodies.map((b) => b.channelId);
      expect(channelIds).toContain('user:user-789:tasks');
      expect(channelIds).toContain('page-456');

      // Both fetches should carry the same event name and payload
      for (const body of bodies) {
        expect(body.event).toBe('task:task_updated');
        expect(body.payload).toEqual(payload);
      }
    });

    it('given payload without pageId, should fan out only to user:{userId}:tasks channel', async () => {
      const payload: TaskEventPayload = {
        type: 'task_added',
        userId: 'user-789',
        data: { title: 'Pageless Task' },
      };

      await broadcastTaskEvent(payload);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.channelId).toBe('user:user-789:tasks');
      expect(body.event).toBe('task:task_added');
    });
  });

  describe('broadcastUsageEvent', () => {
    it('given usage event, should route to notifications:{userId} channel', async () => {
      const payload: UsageEventPayload = {
        userId: 'user-123',
        operation: 'updated',
        subscriptionTier: 'pro',
        standard: { current: 50, limit: 100, remaining: 50 },
        pro: { current: 200, limit: 500, remaining: 300 },
      };

      await broadcastUsageEvent(payload);

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);

      expect(requestBody.channelId).toBe('notifications:user-123');
      expect(requestBody.event).toBe('usage:updated');
    });
  });

  describe('createSignedBroadcastHeaders', () => {
    it('given request body, should include signature header', async () => {
      const payload: PageEventPayload = {
        driveId: 'drive-123',
        pageId: 'page-456',
        operation: 'created',
      };

      await broadcastPageEvent(payload);

      expect(createSignedBroadcastHeaders).toHaveBeenCalled();
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[1].headers['X-Broadcast-Signature']).toMatch(/^t=\d+,v1=/);
    });
  });

  describe('createPageEventPayload', () => {
    it('given minimal arguments, should create payload with required fields', () => {
      const payload = createPageEventPayload('drive-123', 'page-456', 'created');

      expect(payload).toEqual({
        driveId: 'drive-123',
        pageId: 'page-456',
        operation: 'created',
      });
    });

    it('given all options, should include optional fields', () => {
      const payload = createPageEventPayload('drive-123', 'page-456', 'moved', {
        parentId: 'parent-789',
        title: 'Moved Page',
        type: 'DOCUMENT',
        socketId: 'socket-abc',
      });

      expect(payload).toEqual({
        driveId: 'drive-123',
        pageId: 'page-456',
        operation: 'moved',
        parentId: 'parent-789',
        title: 'Moved Page',
        type: 'DOCUMENT',
        socketId: 'socket-abc',
      });
    });
  });

  describe('createDriveEventPayload', () => {
    it('given minimal arguments, should create payload with required fields', () => {
      const payload = createDriveEventPayload('drive-123', 'created');

      expect(payload).toEqual({
        driveId: 'drive-123',
        operation: 'created',
      });
    });

    it('given all options, should include optional fields', () => {
      const payload = createDriveEventPayload('drive-123', 'updated', {
        name: 'Updated Drive',
        slug: 'updated-drive',
      });

      expect(payload).toEqual({
        driveId: 'drive-123',
        operation: 'updated',
        name: 'Updated Drive',
        slug: 'updated-drive',
      });
    });
  });

  describe('createDriveMemberEventPayload', () => {
    it('given minimal arguments, should create payload with required fields', () => {
      const payload = createDriveMemberEventPayload('drive-123', 'user-456', 'member_added');

      expect(payload).toEqual({
        driveId: 'drive-123',
        userId: 'user-456',
        operation: 'member_added',
      });
    });

    it('given all options, should include optional fields', () => {
      const payload = createDriveMemberEventPayload('drive-123', 'user-456', 'member_role_changed', {
        role: 'ADMIN',
        driveName: 'My Drive',
      });

      expect(payload).toEqual({
        driveId: 'drive-123',
        userId: 'user-456',
        operation: 'member_role_changed',
        role: 'ADMIN',
        driveName: 'My Drive',
      });
    });
  });

  describe('broadcastAiStreamStart', () => {
    it('given valid payload, should route to {pageId} channel with chat:stream_start event', async () => {
      const payload: AiStreamStartPayload = {
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        triggeredBy: { userId: 'user-1', displayName: 'Alice', browserSessionId: 'session-1' },
      };

      await broadcastAiStreamStart(payload);

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);

      expect(requestBody.channelId).toBe('page-1');
      expect(requestBody.event).toBe('chat:stream_start');
      expect(requestBody.payload).toEqual(payload);
    });

    it('given no INTERNAL_REALTIME_URL, should not call fetch', async () => {
      process.env.INTERNAL_REALTIME_URL = '';

      await broadcastAiStreamStart({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        triggeredBy: { userId: 'user-1', displayName: 'Alice', browserSessionId: 'session-1' },
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('given fetch throws, should not throw', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(broadcastAiStreamStart({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        triggeredBy: { userId: 'user-1', displayName: 'Alice', browserSessionId: 'session-1' },
      })).resolves.not.toThrow();
    });
  });

  describe('broadcastAiStreamComplete', () => {
    it('given completed stream, should route to {pageId} with chat:stream_complete and aborted=false', async () => {
      const payload: AiStreamCompletePayload = {
        messageId: 'msg-1',
        pageId: 'page-1',
        aborted: false,
      };

      await broadcastAiStreamComplete(payload);

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);

      expect(requestBody.channelId).toBe('page-1');
      expect(requestBody.event).toBe('chat:stream_complete');
      expect(requestBody.payload).toEqual(payload);
    });

    it('given aborted stream, should include aborted=true in payload', async () => {
      const payload: AiStreamCompletePayload = {
        messageId: 'msg-1',
        pageId: 'page-1',
        aborted: true,
      };

      await broadcastAiStreamComplete(payload);

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.payload.aborted).toBe(true);
    });

    it('given no INTERNAL_REALTIME_URL, should not call fetch', async () => {
      process.env.INTERNAL_REALTIME_URL = '';

      await broadcastAiStreamComplete({ messageId: 'msg-1', pageId: 'page-1' });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('given fetch throws, should not throw', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(
        broadcastAiStreamComplete({ messageId: 'msg-1', pageId: 'page-1' })
      ).resolves.not.toThrow();
    });
  });

  describe('broadcastChatUserMessage', () => {
    const payload: ChatUserMessagePayload = {
      message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      pageId: 'page-1',
      conversationId: 'conv-1',
      triggeredBy: { userId: 'user-1', displayName: 'Alice', browserSessionId: 'session-1' },
    };

    it('given a valid payload, should route to the {pageId} channel with chat:user_message event', async () => {
      await broadcastChatUserMessage(payload);

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);

      expect(requestBody.channelId).toBe('page-1');
      expect(requestBody.event).toBe('chat:user_message');
      expect(requestBody.payload).toEqual(payload);
    });

    it('given no INTERNAL_REALTIME_URL, should not call fetch', async () => {
      process.env.INTERNAL_REALTIME_URL = '';

      await broadcastChatUserMessage(payload);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('given fetch throws, should not throw', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(broadcastChatUserMessage(payload)).resolves.not.toThrow();
    });
  });

  describe('broadcastAiMessageEdited', () => {
    const payload: ChatMessageEditedPayload = {
      messageId: 'msg-1',
      pageId: 'page-1',
      conversationId: 'conv-1',
      parts: [{ type: 'text', text: 'updated' }],
      editedAt: '2026-05-01T00:00:00.000Z',
      triggeredBy: { userId: 'user-1', displayName: 'Alice', browserSessionId: 'session-1' },
    };

    it('given a valid payload, should route to the {pageId} channel with chat:message_edited event', async () => {
      await broadcastAiMessageEdited(payload);

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);

      expect(requestBody.channelId).toBe('page-1');
      expect(requestBody.event).toBe('chat:message_edited');
      expect(requestBody.payload).toEqual(payload);
    });

    it('given no INTERNAL_REALTIME_URL, should not call fetch', async () => {
      process.env.INTERNAL_REALTIME_URL = '';

      await broadcastAiMessageEdited(payload);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('given fetch throws, should not throw', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(broadcastAiMessageEdited(payload)).resolves.not.toThrow();
    });
  });

  describe('broadcastAiMessageDeleted', () => {
    const payload: ChatMessageDeletedPayload = {
      messageId: 'msg-1',
      pageId: 'page-1',
      conversationId: 'conv-1',
      triggeredBy: { userId: 'user-1', displayName: 'Alice', browserSessionId: 'session-1' },
    };

    it('given a valid payload, should route to the {pageId} channel with chat:message_deleted event', async () => {
      await broadcastAiMessageDeleted(payload);

      const fetchCall = mockFetch.mock.calls[0];
      const requestBody = JSON.parse(fetchCall[1].body);

      expect(requestBody.channelId).toBe('page-1');
      expect(requestBody.event).toBe('chat:message_deleted');
      expect(requestBody.payload).toEqual(payload);
    });

    it('given no INTERNAL_REALTIME_URL, should not call fetch', async () => {
      process.env.INTERNAL_REALTIME_URL = '';

      await broadcastAiMessageDeleted(payload);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('given fetch throws, should not throw', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      await expect(broadcastAiMessageDeleted(payload)).resolves.not.toThrow();
    });
  });

  describe('channel routing patterns', () => {
    it('given page event, should route to drive-specific channel', async () => {
      await broadcastPageEvent({
        driveId: 'test-drive',
        pageId: 'test-page',
        operation: 'created',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.channelId).toBe('drive:test-drive');
    });

    it('given drive event with recipients, should route to user-specific drives channel', async () => {
      await broadcastDriveEvent({
        driveId: 'test-drive',
        operation: 'created',
      }, ['test-user']);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.channelId).toBe('user:test-user:drives');
    });

    it('given member event, should route to user-specific drives channel', async () => {
      await broadcastDriveMemberEvent({
        driveId: 'test-drive',
        userId: 'test-user',
        operation: 'member_added',
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.channelId).toBe('user:test-user:drives');
    });

    it('given task event, should route to user-specific tasks channel', async () => {
      await broadcastTaskEvent({
        type: 'task_added',
        userId: 'test-user',
        data: {},
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.channelId).toBe('user:test-user:tasks');
    });

    it('given usage event, should route to user notifications channel', async () => {
      await broadcastUsageEvent({
        userId: 'test-user',
        operation: 'updated',
        subscriptionTier: 'free',
        standard: { current: 0, limit: 100, remaining: 100 },
        pro: { current: 0, limit: 0, remaining: 0 },
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.channelId).toBe('notifications:test-user');
    });
  });
});
