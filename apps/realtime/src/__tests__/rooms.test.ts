/**
 * Room Management Tests
 * Tests for Socket.IO room join/leave event handlers
 */

import { describe, it, expect, beforeEach, vi, MockedFunction } from 'vitest';

// Mock the permission functions
vi.mock('@pagespace/lib/permissions-cached', () => ({
  getUserAccessLevel: vi.fn(),
  getUserDriveAccess: vi.fn(),
}));

// Mock the database
vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  },
  eq: vi.fn((field, value) => ({ field, value })),
  or: vi.fn(),
  dmConversations: { id: 'id', participant1Id: 'participant1Id', participant2Id: 'participant2Id' },
}));

// Mock the logger
vi.mock('@pagespace/lib/logger-config', () => ({
  loggers: {
    realtime: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/permissions-cached';
import { db } from '@pagespace/db';

// Create a mock socket that tracks room joins/leaves
const createMockSocket = (userId?: string) => {
  const rooms = new Set<string>();

  return {
    id: 'test-socket-id',
    data: {
      user: userId ? { id: userId } : undefined,
    },
    join: vi.fn((room: string) => {
      rooms.add(room);
    }),
    leave: vi.fn((room: string) => {
      rooms.delete(room);
    }),
    disconnect: vi.fn(),
    _rooms: rooms,
    hasJoinedRoom: (room: string) => rooms.has(room),
  };
};

// Simulate the room join handlers from index.ts
const createRoomHandlers = (socket: ReturnType<typeof createMockSocket>) => {
  const user = socket.data.user;

  return {
    // Auto-join on connect
    onConnect: () => {
      if (user?.id) {
        const notificationRoom = `notifications:${user.id}`;
        const taskRoom = `user:${user.id}:tasks`;
        socket.join(notificationRoom);
        socket.join(taskRoom);
      }
    },

    // join_channel handler
    joinChannel: async (pageId: string) => {
      if (!user?.id) return;

      try {
        const accessLevel = await getUserAccessLevel(user.id, pageId);
        if (accessLevel) {
          socket.join(pageId);
        } else {
          socket.disconnect();
        }
      } catch {
        socket.disconnect();
      }
    },

    // join_drive handler
    joinDrive: async (driveId: string) => {
      if (!user?.id) return;

      try {
        const hasAccess = await getUserDriveAccess(user.id, driveId);
        if (hasAccess) {
          const driveRoom = `drive:${driveId}`;
          socket.join(driveRoom);
        }
      } catch {
        // Silently deny on error
      }
    },

    // join_dm_conversation handler
    joinDmConversation: async (conversationId: string) => {
      const userId = user?.id;
      if (!userId || !conversationId) return;

      const mockDb = db as unknown as { limit: MockedFunction<() => Promise<unknown[]>> };
      const [conversation] = await mockDb.limit() as Array<{
        id: string;
        participant1Id: string;
        participant2Id: string;
      }>;

      if (!conversation || (conversation.participant1Id !== userId && conversation.participant2Id !== userId)) {
        return;
      }

      const room = `dm:${conversationId}`;
      socket.join(room);
    },

    // leave_drive handler
    leaveDrive: (driveId: string) => {
      if (!user?.id) return;

      const driveRoom = `drive:${driveId}`;
      socket.leave(driveRoom);
    },

    // join_global_drives handler
    joinGlobalDrives: () => {
      if (!user?.id) return;

      const globalDrivesRoom = 'global:drives';
      socket.join(globalDrivesRoom);
    },

    // leave_global_drives handler
    leaveGlobalDrives: () => {
      if (!user?.id) return;

      const globalDrivesRoom = 'global:drives';
      socket.leave(globalDrivesRoom);
    },
  };
};

describe('Room Management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('auto-join on connect', () => {
    it('given authenticated user connects, should join notifications and tasks rooms', () => {
      const userId = 'test-user-123';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      handlers.onConnect();

      expect(socket.hasJoinedRoom(`notifications:${userId}`)).toBe(true);
      expect(socket.hasJoinedRoom(`user:${userId}:tasks`)).toBe(true);
    });

    it('given unauthenticated socket, should not join any rooms', () => {
      const socket = createMockSocket(undefined);
      const handlers = createRoomHandlers(socket);

      handlers.onConnect();

      expect(socket.join).not.toHaveBeenCalled();
    });
  });

  describe('join_channel', () => {
    it('given user has page access, should join the page room', async () => {
      const userId = 'test-user-123';
      const pageId = 'test-page-456';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      vi.mocked(getUserAccessLevel).mockResolvedValue('editor');

      await handlers.joinChannel(pageId);

      expect(getUserAccessLevel).toHaveBeenCalledWith(userId, pageId);
      expect(socket.hasJoinedRoom(pageId)).toBe(true);
    });

    it('given user lacks page access, should disconnect socket', async () => {
      const userId = 'test-user-123';
      const pageId = 'test-page-456';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      vi.mocked(getUserAccessLevel).mockResolvedValue(null);

      await handlers.joinChannel(pageId);

      expect(socket.hasJoinedRoom(pageId)).toBe(false);
      expect(socket.disconnect).toHaveBeenCalled();
    });

    it('given permission check throws error, should disconnect socket', async () => {
      const userId = 'test-user-123';
      const pageId = 'test-page-456';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      vi.mocked(getUserAccessLevel).mockRejectedValue(new Error('DB error'));

      await handlers.joinChannel(pageId);

      expect(socket.hasJoinedRoom(pageId)).toBe(false);
      expect(socket.disconnect).toHaveBeenCalled();
    });

    it('given no user in socket.data, should return early', async () => {
      const socket = createMockSocket(undefined);
      const handlers = createRoomHandlers(socket);

      await handlers.joinChannel('page-123');

      expect(getUserAccessLevel).not.toHaveBeenCalled();
    });
  });

  describe('join_drive', () => {
    it('given user is drive member, should join drive room', async () => {
      const userId = 'test-user-123';
      const driveId = 'test-drive-456';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      vi.mocked(getUserDriveAccess).mockResolvedValue(true);

      await handlers.joinDrive(driveId);

      expect(getUserDriveAccess).toHaveBeenCalledWith(userId, driveId);
      expect(socket.hasJoinedRoom(`drive:${driveId}`)).toBe(true);
    });

    it('given user not drive member, should silently deny (no room join)', async () => {
      const userId = 'test-user-123';
      const driveId = 'test-drive-456';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      vi.mocked(getUserDriveAccess).mockResolvedValue(false);

      await handlers.joinDrive(driveId);

      expect(socket.hasJoinedRoom(`drive:${driveId}`)).toBe(false);
      expect(socket.disconnect).not.toHaveBeenCalled();
    });

    it('given no user in socket.data, should return early', async () => {
      const socket = createMockSocket(undefined);
      const handlers = createRoomHandlers(socket);

      await handlers.joinDrive('drive-123');

      expect(getUserDriveAccess).not.toHaveBeenCalled();
    });
  });

  describe('join_dm_conversation', () => {
    it('given user is participant, should join DM room', async () => {
      const userId = 'test-user-123';
      const conversationId = 'conv-456';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      const mockDb = db as unknown as { limit: MockedFunction<() => Promise<unknown[]>> };
      mockDb.limit.mockResolvedValue([{
        id: conversationId,
        participant1Id: userId,
        participant2Id: 'other-user',
      }]);

      await handlers.joinDmConversation(conversationId);

      expect(socket.hasJoinedRoom(`dm:${conversationId}`)).toBe(true);
    });

    it('given user is participant2, should join DM room', async () => {
      const userId = 'test-user-123';
      const conversationId = 'conv-456';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      const mockDb = db as unknown as { limit: MockedFunction<() => Promise<unknown[]>> };
      mockDb.limit.mockResolvedValue([{
        id: conversationId,
        participant1Id: 'other-user',
        participant2Id: userId,
      }]);

      await handlers.joinDmConversation(conversationId);

      expect(socket.hasJoinedRoom(`dm:${conversationId}`)).toBe(true);
    });

    it('given user not participant, should not join room', async () => {
      const userId = 'test-user-123';
      const conversationId = 'conv-456';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      const mockDb = db as unknown as { limit: MockedFunction<() => Promise<unknown[]>> };
      mockDb.limit.mockResolvedValue([{
        id: conversationId,
        participant1Id: 'other-user-1',
        participant2Id: 'other-user-2',
      }]);

      await handlers.joinDmConversation(conversationId);

      expect(socket.hasJoinedRoom(`dm:${conversationId}`)).toBe(false);
    });

    it('given conversation not found, should not join room', async () => {
      const userId = 'test-user-123';
      const conversationId = 'conv-456';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      const mockDb = db as unknown as { limit: MockedFunction<() => Promise<unknown[]>> };
      mockDb.limit.mockResolvedValue([]);

      await handlers.joinDmConversation(conversationId);

      expect(socket.hasJoinedRoom(`dm:${conversationId}`)).toBe(false);
    });
  });

  describe('leave_drive', () => {
    it('given user in drive room, should leave the room', async () => {
      const userId = 'test-user-123';
      const driveId = 'test-drive-456';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      // First join the drive
      vi.mocked(getUserDriveAccess).mockResolvedValue(true);
      await handlers.joinDrive(driveId);
      expect(socket.hasJoinedRoom(`drive:${driveId}`)).toBe(true);

      // Then leave
      handlers.leaveDrive(driveId);

      expect(socket.leave).toHaveBeenCalledWith(`drive:${driveId}`);
      expect(socket.hasJoinedRoom(`drive:${driveId}`)).toBe(false);
    });
  });

  describe('join_global_drives', () => {
    it('given authenticated user, should join global:drives room', () => {
      const userId = 'test-user-123';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      handlers.joinGlobalDrives();

      expect(socket.hasJoinedRoom('global:drives')).toBe(true);
    });

    it('given unauthenticated socket, should not join room', () => {
      const socket = createMockSocket(undefined);
      const handlers = createRoomHandlers(socket);

      handlers.joinGlobalDrives();

      expect(socket.join).not.toHaveBeenCalled();
    });
  });

  describe('leave_global_drives', () => {
    it('given user in global:drives room, should leave the room', () => {
      const userId = 'test-user-123';
      const socket = createMockSocket(userId);
      const handlers = createRoomHandlers(socket);

      // First join
      handlers.joinGlobalDrives();
      expect(socket.hasJoinedRoom('global:drives')).toBe(true);

      // Then leave
      handlers.leaveGlobalDrives();

      expect(socket.leave).toHaveBeenCalledWith('global:drives');
      expect(socket.hasJoinedRoom('global:drives')).toBe(false);
    });
  });
});
