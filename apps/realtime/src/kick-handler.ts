/**
 * Kick Handler
 * Handles permission revocation by removing users from Socket.IO rooms.
 *
 * Supports multiple revocation scenarios:
 * - Drive member removal: kick from drive:*, activity:drive:*
 * - Page permission revocation: kick from specific page room
 * - Full user revocation: kick from all rooms
 */

import { Server, Socket } from 'socket.io';
import { loggers } from '@pagespace/lib/logger-config';
import { socketRegistry } from './socket-registry';

export interface KickPayload {
  userId: string;
  roomPattern: string; // e.g., 'drive:abc123' or 'drive:*' for all drives
  reason: 'member_removed' | 'role_changed' | 'permission_revoked' | 'session_revoked';
  metadata?: {
    driveId?: string;
    pageId?: string;
    driveName?: string;
  };
}

export interface KickResult {
  success: boolean;
  kickedCount: number;
  rooms: string[];
  error?: string;
}

const VALID_REASONS = ['member_removed', 'role_changed', 'permission_revoked', 'session_revoked'] as const;

interface ParseResult {
  success: boolean;
  payload?: KickPayload;
  error?: string;
}

interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Parse the kick request body from JSON
 */
export function parseKickRequest(body: string): ParseResult {
  try {
    const payload = JSON.parse(body) as KickPayload;
    return { success: true, payload };
  } catch {
    return { success: false, error: 'Invalid JSON' };
  }
}

/**
 * Validate the kick payload has required fields
 */
export function validateKickPayload(payload: KickPayload): ValidationResult {
  if (!payload.userId || typeof payload.userId !== 'string' || payload.userId.trim() === '') {
    return { valid: false, error: 'Missing or invalid userId' };
  }

  if (!payload.roomPattern || typeof payload.roomPattern !== 'string' || payload.roomPattern.trim() === '') {
    return { valid: false, error: 'Missing or invalid roomPattern' };
  }

  if (!payload.reason || !VALID_REASONS.includes(payload.reason)) {
    return { valid: false, error: 'Missing or invalid reason' };
  }

  return { valid: true };
}

/**
 * Check if a room matches the given pattern
 * Supports exact match and prefix wildcard (e.g., 'drive:*')
 */
export function roomMatchesPattern(room: string, pattern: string): boolean {
  // Exact match
  if (room === pattern) {
    return true;
  }

  // Wildcard match: 'drive:*' matches any room starting with 'drive:'
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1);
    return room.startsWith(prefix);
  }

  return false;
}

/**
 * Execute the kick operation - remove user's sockets from matching rooms
 */
export function executeKick(
  io: Server,
  payload: KickPayload
): KickResult {
  const { userId, roomPattern, reason, metadata } = payload;

  // Get all sockets for this user
  const userSocketIds = socketRegistry.getSocketsForUser(userId);

  if (userSocketIds.length === 0) {
    loggers.realtime.debug('No sockets found for user during kick', {
      userId,
      roomPattern,
      reason,
    });
    return {
      success: true,
      kickedCount: 0,
      rooms: [],
    };
  }

  const kickedRooms = new Set<string>();
  let kickedCount = 0;

  for (const socketId of userSocketIds) {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) continue;

    // Get rooms this socket is in
    const socketRooms = socketRegistry.getRoomsForSocket(socketId);

    for (const room of socketRooms) {
      if (roomMatchesPattern(room, roomPattern)) {
        // Remove socket from room
        socket.leave(room);
        socketRegistry.trackRoomLeave(socketId, room);
        kickedRooms.add(room);
        kickedCount++;

        // Emit revocation event to the socket so client can handle gracefully
        socket.emit('access_revoked', {
          room,
          reason,
          metadata,
        });
      }
    }
  }

  const rooms = Array.from(kickedRooms);

  loggers.realtime.info('User kicked from rooms', {
    userId,
    roomPattern,
    reason,
    kickedCount,
    rooms,
    socketCount: userSocketIds.length,
  });

  return {
    success: true,
    kickedCount,
    rooms,
  };
}

/**
 * Handle the kick API request
 * Called from the HTTP server when POST /api/kick is received
 */
export function handleKickRequest(
  io: Server,
  body: string
): { status: number; body: KickResult | { error: string } } {
  // Parse request
  const parseResult = parseKickRequest(body);
  if (!parseResult.success || !parseResult.payload) {
    return {
      status: 400,
      body: { error: parseResult.error || 'Parse error' },
    };
  }

  // Validate payload
  const validationResult = validateKickPayload(parseResult.payload);
  if (!validationResult.valid) {
    return {
      status: 400,
      body: { error: validationResult.error || 'Validation error' },
    };
  }

  // Execute kick
  const result = executeKick(io, parseResult.payload);

  return {
    status: 200,
    body: result,
  };
}
