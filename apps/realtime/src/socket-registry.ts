/**
 * Socket Registry
 * Tracks user→socket and socket→room mappings to enable real-time permission revocation.
 *
 * When permissions are revoked, we need to:
 * 1. Find all sockets belonging to a user
 * 2. Find which rooms those sockets are in
 * 3. Remove them from the appropriate rooms
 */

export class SocketRegistry {
  // userId → Set of socketIds
  private userToSockets = new Map<string, Set<string>>();

  // socketId → userId (reverse lookup)
  private socketToUser = new Map<string, string>();

  // socketId → Set of rooms
  private socketToRooms = new Map<string, Set<string>>();

  // room → Set of socketIds (reverse lookup for room membership)
  private roomToSockets = new Map<string, Set<string>>();

  /**
   * Register a socket for a user (called on connect)
   */
  registerSocket(userId: string, socketId: string): void {
    // Add to user→sockets mapping
    if (!this.userToSockets.has(userId)) {
      this.userToSockets.set(userId, new Set());
    }
    this.userToSockets.get(userId)!.add(socketId);

    // Add reverse lookup
    this.socketToUser.set(socketId, userId);

    // Initialize room tracking for this socket
    this.socketToRooms.set(socketId, new Set());
  }

  /**
   * Unregister a socket (called on disconnect)
   */
  unregisterSocket(socketId: string): void {
    const userId = this.socketToUser.get(socketId);

    // Remove from user→sockets mapping
    if (userId) {
      const userSockets = this.userToSockets.get(userId);
      if (userSockets) {
        userSockets.delete(socketId);
        if (userSockets.size === 0) {
          this.userToSockets.delete(userId);
        }
      }
    }

    // Clean up room memberships
    const rooms = this.socketToRooms.get(socketId);
    if (rooms) {
      for (const room of rooms) {
        const roomSockets = this.roomToSockets.get(room);
        if (roomSockets) {
          roomSockets.delete(socketId);
          if (roomSockets.size === 0) {
            this.roomToSockets.delete(room);
          }
        }
      }
    }

    // Remove reverse lookup and room tracking
    this.socketToUser.delete(socketId);
    this.socketToRooms.delete(socketId);
  }

  /**
   * Get all socket IDs for a user
   */
  getSocketsForUser(userId: string): string[] {
    const sockets = this.userToSockets.get(userId);
    return sockets ? Array.from(sockets) : [];
  }

  /**
   * Get the user ID for a socket
   */
  getUserForSocket(socketId: string): string | undefined {
    return this.socketToUser.get(socketId);
  }

  /**
   * Track when a socket joins a room
   */
  trackRoomJoin(socketId: string, room: string): void {
    // Add to socket→rooms mapping
    if (!this.socketToRooms.has(socketId)) {
      this.socketToRooms.set(socketId, new Set());
    }
    this.socketToRooms.get(socketId)!.add(room);

    // Add to room→sockets mapping
    if (!this.roomToSockets.has(room)) {
      this.roomToSockets.set(room, new Set());
    }
    this.roomToSockets.get(room)!.add(socketId);
  }

  /**
   * Track when a socket leaves a room
   */
  trackRoomLeave(socketId: string, room: string): void {
    // Remove from socket→rooms mapping
    const socketRooms = this.socketToRooms.get(socketId);
    if (socketRooms) {
      socketRooms.delete(room);
    }

    // Remove from room→sockets mapping
    const roomSockets = this.roomToSockets.get(room);
    if (roomSockets) {
      roomSockets.delete(socketId);
      if (roomSockets.size === 0) {
        this.roomToSockets.delete(room);
      }
    }
  }

  /**
   * Get all rooms a socket is in
   */
  getRoomsForSocket(socketId: string): string[] {
    const rooms = this.socketToRooms.get(socketId);
    return rooms ? Array.from(rooms) : [];
  }

  /**
   * Get all sockets in a room
   */
  getSocketsInRoom(room: string): string[] {
    const sockets = this.roomToSockets.get(room);
    return sockets ? Array.from(sockets) : [];
  }

  /**
   * Get sockets for a specific user that are in a specific room
   * Used to kick a user from a specific drive/page
   */
  getSocketsForUserInRoom(userId: string, room: string): string[] {
    const userSockets = this.getSocketsForUser(userId);
    const roomSockets = new Set(this.getSocketsInRoom(room));
    return userSockets.filter(socketId => roomSockets.has(socketId));
  }
}

// Singleton instance for the realtime service
export const socketRegistry = new SocketRegistry();
