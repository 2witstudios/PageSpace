/**
 * Socket Registry Tests
 * Tests for tracking user→socket mappings to enable permission revocation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SocketRegistry } from '../socket-registry';

describe('SocketRegistry', () => {
  let registry: SocketRegistry;

  beforeEach(() => {
    registry = new SocketRegistry();
  });

  describe('registerSocket', () => {
    it('given a user and socket, should track the socket for that user', () => {
      const userId = 'user-123';
      const socketId = 'socket-abc';

      registry.registerSocket(userId, socketId);

      expect(registry.getSocketsForUser(userId)).toContain(socketId);
    });

    it('given multiple sockets for same user, should track all sockets', () => {
      const userId = 'user-123';
      const socketId1 = 'socket-abc';
      const socketId2 = 'socket-def';

      registry.registerSocket(userId, socketId1);
      registry.registerSocket(userId, socketId2);

      const sockets = registry.getSocketsForUser(userId);
      expect(sockets).toContain(socketId1);
      expect(sockets).toContain(socketId2);
      expect(sockets.length).toBe(2);
    });
  });

  describe('unregisterSocket', () => {
    it('given a registered socket, should remove it from tracking', () => {
      const userId = 'user-123';
      const socketId = 'socket-abc';

      registry.registerSocket(userId, socketId);
      registry.unregisterSocket(socketId);

      expect(registry.getSocketsForUser(userId)).not.toContain(socketId);
    });

    it('given multiple sockets for user, should only remove the specified socket', () => {
      const userId = 'user-123';
      const socketId1 = 'socket-abc';
      const socketId2 = 'socket-def';

      registry.registerSocket(userId, socketId1);
      registry.registerSocket(userId, socketId2);
      registry.unregisterSocket(socketId1);

      const sockets = registry.getSocketsForUser(userId);
      expect(sockets).not.toContain(socketId1);
      expect(sockets).toContain(socketId2);
    });

    it('given unregistered socket, should not throw', () => {
      expect(() => registry.unregisterSocket('nonexistent')).not.toThrow();
    });
  });

  describe('getSocketsForUser', () => {
    it('given user with no sockets, should return empty array', () => {
      expect(registry.getSocketsForUser('nonexistent')).toEqual([]);
    });
  });

  describe('getUserForSocket', () => {
    it('given registered socket, should return the user id', () => {
      const userId = 'user-123';
      const socketId = 'socket-abc';

      registry.registerSocket(userId, socketId);

      expect(registry.getUserForSocket(socketId)).toBe(userId);
    });

    it('given unregistered socket, should return undefined', () => {
      expect(registry.getUserForSocket('nonexistent')).toBeUndefined();
    });
  });

  describe('trackRoomJoin', () => {
    it('given socket joins a room, should track the room membership', () => {
      const socketId = 'socket-abc';
      const room = 'drive:drive-123';

      registry.trackRoomJoin(socketId, room);

      expect(registry.getRoomsForSocket(socketId)).toContain(room);
    });

    it('given socket joins multiple rooms, should track all rooms', () => {
      const socketId = 'socket-abc';
      const room1 = 'drive:drive-123';
      const room2 = 'page-456';

      registry.trackRoomJoin(socketId, room1);
      registry.trackRoomJoin(socketId, room2);

      const rooms = registry.getRoomsForSocket(socketId);
      expect(rooms).toContain(room1);
      expect(rooms).toContain(room2);
    });
  });

  describe('trackRoomLeave', () => {
    it('given socket leaves a tracked room, should remove from tracking', () => {
      const socketId = 'socket-abc';
      const room = 'drive:drive-123';

      registry.trackRoomJoin(socketId, room);
      registry.trackRoomLeave(socketId, room);

      expect(registry.getRoomsForSocket(socketId)).not.toContain(room);
    });
  });

  describe('getRoomsForSocket', () => {
    it('given socket with no rooms, should return empty array', () => {
      expect(registry.getRoomsForSocket('nonexistent')).toEqual([]);
    });
  });

  describe('getSocketsInRoom', () => {
    it('given room with multiple sockets, should return all socket ids', () => {
      const room = 'drive:drive-123';
      const socketId1 = 'socket-abc';
      const socketId2 = 'socket-def';

      registry.trackRoomJoin(socketId1, room);
      registry.trackRoomJoin(socketId2, room);

      const sockets = registry.getSocketsInRoom(room);
      expect(sockets).toContain(socketId1);
      expect(sockets).toContain(socketId2);
    });

    it('given room with no sockets, should return empty array', () => {
      expect(registry.getSocketsInRoom('nonexistent')).toEqual([]);
    });
  });

  describe('getSocketsForUserInRoom', () => {
    it('given user has sockets in specific room, should return only those sockets', () => {
      const userId = 'user-123';
      const socketId1 = 'socket-abc';
      const socketId2 = 'socket-def';
      const room = 'drive:drive-123';
      const otherRoom = 'drive:other-456';

      registry.registerSocket(userId, socketId1);
      registry.registerSocket(userId, socketId2);
      registry.trackRoomJoin(socketId1, room);
      registry.trackRoomJoin(socketId2, otherRoom);

      const socketsInRoom = registry.getSocketsForUserInRoom(userId, room);
      expect(socketsInRoom).toContain(socketId1);
      expect(socketsInRoom).not.toContain(socketId2);
    });

    it('given user has no sockets in room, should return empty array', () => {
      const userId = 'user-123';
      const socketId = 'socket-abc';
      const room = 'drive:drive-123';

      registry.registerSocket(userId, socketId);
      // Socket not joined to room

      expect(registry.getSocketsForUserInRoom(userId, room)).toEqual([]);
    });
  });

  describe('cleanup on unregister', () => {
    it('given socket unregistered, should clean up room tracking', () => {
      const userId = 'user-123';
      const socketId = 'socket-abc';
      const room = 'drive:drive-123';

      registry.registerSocket(userId, socketId);
      registry.trackRoomJoin(socketId, room);
      registry.unregisterSocket(socketId);

      expect(registry.getRoomsForSocket(socketId)).toEqual([]);
      expect(registry.getSocketsInRoom(room)).not.toContain(socketId);
    });
  });
});
