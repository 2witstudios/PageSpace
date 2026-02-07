import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Server, Socket } from 'socket.io';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/permissions-cached';
import { sessionService } from '@pagespace/lib/auth';
import { verifyBroadcastSignature } from '@pagespace/lib/broadcast-auth';
import * as dotenv from 'dotenv';
import { db, eq, gt, and, or, dmConversations, socketTokens, users, userProfiles, pages } from '@pagespace/db';
import {
  validatePageId,
  validateDriveId,
  validateConversationId,
  validatePresencePagePayload,
  emitValidationError,
} from './validation';
import { loggers } from '@pagespace/lib/logger-config';
import { createHash } from 'crypto';
import { socketRegistry } from './socket-registry';
import { handleKickRequest } from './kick-handler';
import { presenceTracker, type PresenceViewer } from './presence-tracker';

dotenv.config({ path: '../../.env' });

/**
 * Validate a short-lived socket token (ps_sock_* format).
 * These tokens are created by /api/auth/socket-token to bypass sameSite: 'strict' cookies.
 *
 * @param token - The socket token to validate
 * @returns Object with userId if valid, null if invalid or expired
 */
async function validateSocketToken(token: string): Promise<{ userId: string } | null> {
  if (!token.startsWith('ps_sock_')) {
    return null;
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  try {
    const record = await db.query.socketTokens.findFirst({
      where: and(
        eq(socketTokens.tokenHash, tokenHash),
        gt(socketTokens.expiresAt, new Date())
      ),
    });

    if (!record) {
      loggers.realtime.debug('Socket token not found or expired', { tokenHashPrefix: tokenHash.substring(0, 8) });
      return null;
    }

    loggers.realtime.debug('Socket token validated successfully', { userId: record.userId });
    return { userId: record.userId };
  } catch (error) {
    loggers.realtime.error('Error validating socket token', error as Error);
    return null;
  }
}

/**
 * Origin Validation for WebSocket Connections (Defense-in-Depth with Blocking)
 *
 * This module provides explicit origin validation that BLOCKS invalid origins.
 * Socket.IO CORS is a first line of defense, but this provides defense-in-depth
 * by rejecting connections from unexpected origins at the middleware level.
 */

/**
 * Normalizes an origin URL by extracting protocol, host, and port
 * This ensures consistent comparison between origins
 *
 * @param origin - The origin URL to normalize
 * @returns Normalized origin (protocol://host:port) or empty string if invalid
 */
function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.origin;
  } catch {
    return '';
  }
}

/**
 * Gets the list of allowed origins from environment configuration
 *
 * @returns Array of allowed origin URLs
 */
function getAllowedOrigins(): string[] {
  const origins: string[] = [];

  // Primary origins from CORS_ORIGIN or WEB_APP_URL (matches Socket.IO CORS config)
  const corsOrigin = process.env.CORS_ORIGIN;
  const webAppUrl = process.env.WEB_APP_URL;

  if (corsOrigin) {
    const normalized = normalizeOrigin(corsOrigin);
    if (normalized) origins.push(normalized);
  } else if (webAppUrl) {
    const normalized = normalizeOrigin(webAppUrl);
    if (normalized) origins.push(normalized);
  }

  // Additional origins from ADDITIONAL_ALLOWED_ORIGINS (comma-separated)
  const additionalOrigins = process.env.ADDITIONAL_ALLOWED_ORIGINS;
  if (additionalOrigins) {
    const parsed = additionalOrigins
      .split(',')
      .map((o) => normalizeOrigin(o.trim()))
      .filter((o) => o.length > 0);
    origins.push(...parsed);
  }

  return origins;
}

/**
 * Checks if the given origin is in the allowed list
 *
 * @param origin - The origin to validate
 * @param allowedOrigins - List of allowed origins
 * @returns true if origin is allowed, false otherwise
 */
function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  return allowedOrigins.some((allowed) => allowed === normalizedOrigin);
}

/**
 * Result of WebSocket origin validation
 */
interface WebSocketOriginValidationResult {
  /** Whether the origin is valid (allowed or not required) */
  isValid: boolean;
  /** The origin that was validated (normalized), or undefined if not provided */
  origin: string | undefined;
  /** Reason for the validation result */
  reason: 'valid' | 'no_origin' | 'invalid' | 'no_config';
}

/**
 * Validates a WebSocket connection origin against allowed origins
 *
 * This helper function provides a simple boolean check for origin validation.
 * It can be used for additional security monitoring or optional blocking decisions.
 *
 * Validation rules:
 * - Missing origin: Returns valid (non-browser clients like curl, mobile apps)
 * - No config: Returns valid with warning (CORS_ORIGIN/WEB_APP_URL not set)
 * - Origin matches allowed list: Returns valid
 * - Origin doesn't match: Returns invalid
 *
 * @param origin - The Origin header value from the connection request
 * @returns Validation result with isValid boolean and reason
 *
 * @example
 * ```typescript
 * const result = validateWebSocketOrigin(socket.handshake.headers.origin);
 * if (!result.isValid) {
 *   // Optionally reject the connection or log a warning
 *   socket.disconnect();
 * }
 * ```
 */
function validateWebSocketOrigin(origin: string | undefined): WebSocketOriginValidationResult {
  // No origin header - non-browser client, allow by default
  if (!origin) {
    return {
      isValid: true,
      origin: undefined,
      reason: 'no_origin',
    };
  }

  const normalizedOrigin = normalizeOrigin(origin);
  const allowedOrigins = getAllowedOrigins();

  // No allowed origins configured - allow but this is a misconfiguration
  if (allowedOrigins.length === 0) {
    return {
      isValid: true,
      origin: normalizedOrigin || origin,
      reason: 'no_config',
    };
  }

  // Check if origin is in allowed list
  if (isOriginAllowed(origin, allowedOrigins)) {
    return {
      isValid: true,
      origin: normalizedOrigin,
      reason: 'valid',
    };
  }

  // Origin not in allowed list
  return {
    isValid: false,
    origin: normalizedOrigin || origin,
    reason: 'invalid',
  };
}

/**
 * Validates WebSocket connection origin and returns whether to allow the connection
 *
 * This function BLOCKS connections from invalid origins (defense-in-depth).
 * Socket.IO CORS is a first line of defense, but this provides additional protection.
 *
 * @param origin - The Origin header value from the connection request
 * @param metadata - Additional metadata for logging (socketId, IP, etc.)
 * @returns true if connection should be allowed, false if it should be rejected
 */
function validateAndLogWebSocketOrigin(
  origin: string | undefined,
  metadata: { socketId: string; ip: string | undefined; userAgent: string | undefined }
): boolean {
  const allowedOrigins = getAllowedOrigins();

  // No origin header - non-browser client (curl, mobile apps, etc.)
  // Allow these as they authenticate via tokens, not cookies
  if (!origin) {
    loggers.realtime.debug('WebSocket origin validation: no Origin header', {
      ...metadata,
      reason: 'Non-browser client or same-origin request',
    });
    return true;
  }

  // No allowed origins configured in production is a misconfiguration
  // In development, allow but warn. In production, this should fail closed.
  if (allowedOrigins.length === 0) {
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction) {
      loggers.realtime.error('WebSocket origin validation: REJECTED - no allowed origins configured in production', {
        ...metadata,
        origin,
        severity: 'security',
        reason: 'CORS_ORIGIN and WEB_APP_URL not set in production',
      });
      return false;
    }
    loggers.realtime.warn('WebSocket origin validation: no allowed origins configured (allowing in development)', {
      ...metadata,
      origin,
      reason: 'CORS_ORIGIN and WEB_APP_URL not set',
    });
    return true;
  }

  // Check if origin is allowed
  if (isOriginAllowed(origin, allowedOrigins)) {
    loggers.realtime.debug('WebSocket origin validation: valid origin', {
      ...metadata,
      origin,
    });
    return true;
  }

  // Origin not in allowed list - REJECT the connection
  loggers.realtime.warn('WebSocket origin validation: REJECTED - unexpected origin', {
    ...metadata,
    origin,
    allowedOrigins,
    severity: 'security',
    reason: 'Origin not in allowed list - connection rejected',
  });
  return false;
}

const requestListener = (req: IncomingMessage, res: ServerResponse) => {
    // Helper to verify signature (shared by broadcast and kick)
    const verifySignature = (signatureHeader: string | undefined, body: string): boolean => {
        if (!signatureHeader) {
            loggers.realtime.warn('Request missing signature header', {
                url: req.url,
                ip: req.socket.remoteAddress,
                userAgent: req.headers['user-agent']
            });
            return false;
        }

        if (!verifyBroadcastSignature(signatureHeader, body)) {
            loggers.realtime.error('Request signature verification failed', {
                url: req.url,
                ip: req.socket.remoteAddress,
                userAgent: req.headers['user-agent'],
                hasSignature: !!signatureHeader,
                bodyLength: body.length
            });
            return false;
        }

        return true;
    };

    if (req.method === 'POST' && req.url === '/api/broadcast') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const signatureHeader = req.headers['x-broadcast-signature'] as string;
                if (!verifySignature(signatureHeader, body)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Authentication failed' }));
                    return;
                }

                const { channelId, event, payload } = JSON.parse(body);
                if (channelId && event && payload) {
                    io.to(channelId).emit(event, payload);
                    loggers.realtime.debug('Broadcast event sent successfully', {
                        channelId,
                        event,
                        payloadKeys: Object.keys(payload)
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    loggers.realtime.warn('Invalid broadcast payload structure', {
                        hasChannelId: !!channelId,
                        hasEvent: !!event,
                        hasPayload: !!payload
                    });
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid broadcast payload' }));
                }
            } catch (error) {
                loggers.realtime.error('Broadcast request processing error', error as Error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/api/kick') {
        // Kick API: Remove user from rooms on permission revocation
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            const signatureHeader = req.headers['x-broadcast-signature'] as string;
            if (!verifySignature(signatureHeader, body)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Authentication failed' }));
                return;
            }

            const result = handleKickRequest(io, body);
            res.writeHead(result.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.body));
        });
    } else {
        res.writeHead(404);
        res.end();
    }
};

const httpServer = createServer(requestListener);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || process.env.WEB_APP_URL,
    credentials: true,
  },
});

interface AuthSocket extends Socket {
  data: {
    user?: {
      id: string;
      name: string;
      avatarUrl: string | null;
    };
  };
}

/**
 * Look up user display metadata (name, avatar) and store on socket.data.
 * Called once per connection to avoid repeated DB queries during presence joins.
 */
async function populateUserMetadata(socket: AuthSocket): Promise<void> {
  const userId = socket.data.user?.id;
  if (!userId) return;

  try {
    const [userResult, profileResult] = await Promise.all([
      db.select({ name: users.name, image: users.image }).from(users).where(eq(users.id, userId)).limit(1),
      db.select({ displayName: userProfiles.displayName, avatarUrl: userProfiles.avatarUrl }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1),
    ]);

    const name = profileResult[0]?.displayName || userResult[0]?.name || 'Unknown';
    const avatarUrl = profileResult[0]?.avatarUrl || userResult[0]?.image || null;

    socket.data.user = { id: userId, name, avatarUrl };
  } catch (error) {
    loggers.realtime.error('Error populating user metadata', error as Error, { userId });
    // Keep the basic user data (just id) - presence will work with fallback name
    socket.data.user = { id: userId, name: 'Unknown', avatarUrl: null };
  }
}

io.use(async (socket: AuthSocket, next) => {
  // Extract connection metadata for logging
  const connectionMetadata = {
    socketId: socket.id,
    ip: socket.handshake.address,
    userAgent: socket.handshake.headers['user-agent']?.substring(0, 100),
  };

  // Validate Origin header - REJECT invalid origins (defense-in-depth)
  const origin = socket.handshake.headers.origin;
  const isOriginValid = validateAndLogWebSocketOrigin(origin, connectionMetadata);
  if (!isOriginValid) {
    return next(new Error('Origin not allowed'));
  }

  // Debug: Log all available authentication sources
  loggers.realtime.debug('Socket.IO: Authentication attempt', {
    authField: !!socket.handshake.auth.token,
    authTokenLength: socket.handshake.auth.token?.length || 0,
    hasCookieHeader: !!socket.handshake.headers.cookie,
    cookieHeader: socket.handshake.headers.cookie ? 'present' : 'missing',
    origin: origin,
    userAgent: socket.handshake.headers['user-agent']?.substring(0, 50)
  });

  // Get token from auth field (socket token from /api/auth/socket-token or session token from desktop app)
  const token = socket.handshake.auth.token;

  if (!token) {
    loggers.realtime.warn('Socket.IO: No token found in auth field', {
      authFieldEmpty: !socket.handshake.auth.token,
    });
    return next(new Error('Authentication error: No token provided.'));
  }

  // Check for socket token (ps_sock_*) first - these bypass sameSite: 'strict' cookies
  if (token.startsWith('ps_sock_')) {
    const socketAuth = await validateSocketToken(token);
    if (socketAuth) {
      socket.data.user = { id: socketAuth.userId, name: 'Unknown', avatarUrl: null };
      await populateUserMetadata(socket);
      loggers.realtime.info('Socket.IO: User authenticated via socket token', { userId: socketAuth.userId });
      return next();
    }
    loggers.realtime.warn('Socket.IO: Socket token validation failed');
    return next(new Error('Authentication error: Invalid or expired socket token.'));
  }

  // Check for session token (ps_sess_*) - used by mobile/desktop clients
  if (token.startsWith('ps_sess_')) {
    try {
      const sessionClaims = await sessionService.validateSession(token);
      if (!sessionClaims) {
        loggers.realtime.warn('Socket.IO: Session token validation failed');
        return next(new Error('Authentication error: Invalid or expired session.'));
      }

      socket.data.user = { id: sessionClaims.userId, name: 'Unknown', avatarUrl: null };
      await populateUserMetadata(socket);
      loggers.realtime.info('Socket.IO: User authenticated via session token', { userId: sessionClaims.userId });
      return next();
    } catch (error) {
      loggers.realtime.error('Error validating session token', error as Error);
      return next(new Error('Authentication error: Server failed.'));
    }
  }

  // Unknown token format
  loggers.realtime.warn('Socket.IO: Unknown token format', { tokenPrefix: token.substring(0, 8) });
  return next(new Error('Authentication error: Invalid token format.'));
});

io.on('connection', (socket: AuthSocket) => {
  loggers.realtime.info('User connected', { socketId: socket.id });
  const user = socket.data.user;

  // Register socket in the registry for permission revocation tracking
  if (user?.id) {
    socketRegistry.registerSocket(user.id, socket.id);
  }

  // Auto-join user's notification room and task room
  if (user?.id) {
    const notificationRoom = `notifications:${user.id}`;
    const taskRoom = `user:${user.id}:tasks`;
    const userDrivesRoom = `user:${user.id}:drives`;
    socket.join(notificationRoom);
    socket.join(taskRoom);
    socket.join(userDrivesRoom);
    // Track in registry (these are always-on rooms, not permission-gated)
    socketRegistry.trackRoomJoin(socket.id, notificationRoom);
    socketRegistry.trackRoomJoin(socket.id, taskRoom);
    socketRegistry.trackRoomJoin(socket.id, userDrivesRoom);
    loggers.realtime.debug('User joined notification, task, and drives rooms', {
      userId: user.id,
      rooms: [notificationRoom, taskRoom, userDrivesRoom]
    });
  }

  socket.on('join_channel', async (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload before any DB query
    const validation = validatePageId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid join_channel payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'join_channel', validation.error);
      return;
    }
    const pageId = validation.value;

    try {
      const accessLevel = await getUserAccessLevel(user.id, pageId);
      if (accessLevel) {
        socket.join(pageId);
        socketRegistry.trackRoomJoin(socket.id, pageId);
        loggers.realtime.debug('User joined channel', { userId: user.id, channelId: pageId });
      } else {
        loggers.realtime.warn('User denied access to channel', { userId: user.id, channelId: pageId });
        socket.disconnect();
      }
    } catch (error) {
      loggers.realtime.error('Error joining channel', error as Error, { channelId: pageId });
      socket.disconnect();
    }
  });

  socket.on('join_drive', async (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload before any DB query
    const validation = validateDriveId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid join_drive payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'join_drive', validation.error);
      return;
    }
    const driveId = validation.value;

    try {
      const hasAccess = await getUserDriveAccess(user.id, driveId);
      if (hasAccess) {
        const driveRoom = `drive:${driveId}`;
        socket.join(driveRoom);
        socketRegistry.trackRoomJoin(socket.id, driveRoom);
        loggers.realtime.debug('User joined drive room', { userId: user.id, room: driveRoom });
      } else {
        loggers.realtime.warn('User denied access to drive', { userId: user.id, driveId });
      }
    } catch (error) {
      loggers.realtime.error('Error joining drive', error as Error, { driveId });
    }
  });

  // Join a direct message conversation room after membership verification
  // Security: Uses filter-in-query pattern - authorization is part of the query, not post-query
  socket.on('join_dm_conversation', async (payload: unknown) => {
    const userId = user?.id;
    if (!userId) return;

    // Validate payload before any DB query
    const validation = validateConversationId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid join_dm_conversation payload', { userId, error: validation.error });
      emitValidationError(socket, 'join_dm_conversation', validation.error);
      return;
    }
    const conversationId = validation.value;

    try {
      // Filter-in-query: Authorization is part of the WHERE clause
      // Only returns a row if the user is a participant
      const [conversation] = await db
        .select({ id: dmConversations.id })
        .from(dmConversations)
        .where(
          and(
            eq(dmConversations.id, conversationId),
            or(
              eq(dmConversations.participant1Id, userId),
              eq(dmConversations.participant2Id, userId)
            )
          )
        )
        .limit(1);

      if (!conversation) {
        loggers.realtime.warn('DM join denied: not a participant or not found', { userId, conversationId });
        return;
      }

      const room = `dm:${conversationId}`;
      socket.join(room);
      socketRegistry.trackRoomJoin(socket.id, room);
      loggers.realtime.debug('User joined DM room', { userId, room });
    } catch (error) {
      loggers.realtime.error('Error joining DM conversation', error as Error, { conversationId });
    }
  });

  socket.on('leave_dm_conversation', (payload: unknown) => {
    const userId = user?.id;
    if (!userId) return;

    // Validate payload - leave operations still need format validation
    const validation = validateConversationId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid leave_dm_conversation payload', { userId, error: validation.error });
      emitValidationError(socket, 'leave_dm_conversation', validation.error);
      return;
    }
    const conversationId = validation.value;

    const room = `dm:${conversationId}`;
    socket.leave(room);
    socketRegistry.trackRoomLeave(socket.id, room);
    loggers.realtime.debug('User left DM room', { userId, room });
  });

  socket.on('leave_drive', (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload
    const validation = validateDriveId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid leave_drive payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'leave_drive', validation.error);
      return;
    }
    const driveId = validation.value;

    const driveRoom = `drive:${driveId}`;
    socket.leave(driveRoom);
    socketRegistry.trackRoomLeave(socket.id, driveRoom);
    loggers.realtime.debug('User left drive room', { userId: user.id, room: driveRoom });
  });

  socket.on('join_global_drives', () => {
    if (!user?.id) return;

    const globalDrivesRoom = 'global:drives';
    socket.join(globalDrivesRoom);
    socketRegistry.trackRoomJoin(socket.id, globalDrivesRoom);
    loggers.realtime.debug('User joined global drives room', { userId: user.id, room: globalDrivesRoom });
  });

  socket.on('leave_global_drives', () => {
    if (!user?.id) return;

    const globalDrivesRoom = 'global:drives';
    socket.leave(globalDrivesRoom);
    socketRegistry.trackRoomLeave(socket.id, globalDrivesRoom);
    loggers.realtime.debug('User left global drives room', { userId: user.id, room: globalDrivesRoom });
  });

  // Activity channel handlers - for real-time activity feed updates
  socket.on('join_activity_drive', async (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload before any DB query
    const validation = validateDriveId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid join_activity_drive payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'join_activity_drive', validation.error);
      return;
    }
    const driveId = validation.value;

    try {
      const hasAccess = await getUserDriveAccess(user.id, driveId);
      if (hasAccess) {
        const activityRoom = `activity:drive:${driveId}`;
        socket.join(activityRoom);
        socketRegistry.trackRoomJoin(socket.id, activityRoom);
        loggers.realtime.debug('User joined activity drive room', { userId: user.id, room: activityRoom });
      } else {
        loggers.realtime.warn('User denied access to activity drive', { userId: user.id, driveId });
      }
    } catch (error) {
      loggers.realtime.error('Error joining activity drive', error as Error, { driveId });
    }
  });

  socket.on('join_activity_page', async (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload before any DB query
    const validation = validatePageId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid join_activity_page payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'join_activity_page', validation.error);
      return;
    }
    const pageId = validation.value;

    try {
      const accessLevel = await getUserAccessLevel(user.id, pageId);
      if (accessLevel) {
        const activityRoom = `activity:page:${pageId}`;
        socket.join(activityRoom);
        socketRegistry.trackRoomJoin(socket.id, activityRoom);
        loggers.realtime.debug('User joined activity page room', { userId: user.id, room: activityRoom });
      } else {
        loggers.realtime.warn('User denied access to activity page', { userId: user.id, pageId });
      }
    } catch (error) {
      loggers.realtime.error('Error joining activity page', error as Error, { pageId });
    }
  });

  socket.on('leave_activity_drive', (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload
    const validation = validateDriveId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid leave_activity_drive payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'leave_activity_drive', validation.error);
      return;
    }
    const driveId = validation.value;

    const activityRoom = `activity:drive:${driveId}`;
    socket.leave(activityRoom);
    socketRegistry.trackRoomLeave(socket.id, activityRoom);
    loggers.realtime.debug('User left activity drive room', { userId: user.id, room: activityRoom });
  });

  socket.on('leave_activity_page', (payload: unknown) => {
    if (!user?.id) return;

    // Validate payload
    const validation = validatePageId(payload);
    if (!validation.ok) {
      loggers.realtime.warn('Invalid leave_activity_page payload', { userId: user.id, error: validation.error });
      emitValidationError(socket, 'leave_activity_page', validation.error);
      return;
    }
    const pageId = validation.value;

    const activityRoom = `activity:page:${pageId}`;
    socket.leave(activityRoom);
    socketRegistry.trackRoomLeave(socket.id, activityRoom);
    loggers.realtime.debug('User left activity page room', { userId: user.id, room: activityRoom });
  });

  // Presence tracking: join a page as a viewer
  socket.on('presence:join_page', async (payload: unknown) => {
    if (!user?.id) return;

    const pageValidation = validatePresencePagePayload(payload);
    if (!pageValidation.ok) {
      emitValidationError(socket, 'presence:join_page', pageValidation.error);
      return;
    }
    const pageId = pageValidation.value;

    try {
      // Verify the user has access to this page
      const accessLevel = await getUserAccessLevel(user.id, pageId);
      if (!accessLevel) {
        loggers.realtime.warn('Presence denied: no page access', { userId: user.id, pageId });
        return;
      }

      // Look up the page's driveId (user metadata is cached on socket.data from connection)
      const [pageResult] = await db
        .select({ driveId: pages.driveId })
        .from(pages)
        .where(eq(pages.id, pageId))
        .limit(1);

      if (!pageResult) {
        loggers.realtime.warn('Presence: page not found', { pageId });
        return;
      }

      const driveId = pageResult.driveId;

      const presenceUser: PresenceViewer = {
        userId: user.id,
        socketId: socket.id,
        name: user.name,
        avatarUrl: user.avatarUrl,
      };

      presenceTracker.addViewer(pageId, driveId, presenceUser);
      const uniqueViewers = presenceTracker.getUniqueViewers(pageId);

      // Broadcast to the page room (for the content header)
      io.to(pageId).emit('presence:page_viewers', {
        pageId,
        viewers: uniqueViewers,
      });

      // Broadcast to the drive room (for the sidebar page tree)
      io.to(`drive:${driveId}`).emit('presence:page_viewers', {
        pageId,
        viewers: uniqueViewers,
      });

      loggers.realtime.debug('User joined page presence', {
        userId: user.id,
        pageId,
        viewerCount: uniqueViewers.length,
      });
    } catch (error) {
      loggers.realtime.error('Error joining page presence', error as Error, { pageId });
    }
  });

  // Presence tracking: leave a page
  socket.on('presence:leave_page', (payload: unknown) => {
    if (!user?.id) return;

    const pageValidation = validatePresencePagePayload(payload);
    if (!pageValidation.ok) {
      emitValidationError(socket, 'presence:leave_page', pageValidation.error);
      return;
    }
    const pageId = pageValidation.value;

    const driveId = presenceTracker.getDriveId(pageId);
    presenceTracker.removeViewer(socket.id, pageId);
    const uniqueViewers = presenceTracker.getUniqueViewers(pageId);

    // Broadcast updated viewer list to page room
    io.to(pageId).emit('presence:page_viewers', {
      pageId,
      viewers: uniqueViewers,
    });

    // Broadcast to drive room if we know the driveId
    if (driveId) {
      io.to(`drive:${driveId}`).emit('presence:page_viewers', {
        pageId,
        viewers: uniqueViewers,
      });
    }

    loggers.realtime.debug('User left page presence', {
      userId: user.id,
      pageId,
      viewerCount: uniqueViewers.length,
    });
  });

  socket.on('disconnect', (reason) => {
    // Clean up presence tracking and broadcast updates for affected pages
    const affectedPages = presenceTracker.removeSocket(socket.id);
    for (const { pageId, driveId } of affectedPages) {
      const uniqueViewers = presenceTracker.getUniqueViewers(pageId);

      io.to(pageId).emit('presence:page_viewers', {
        pageId,
        viewers: uniqueViewers,
      });

      if (driveId) {
        io.to(`drive:${driveId}`).emit('presence:page_viewers', {
          pageId,
          viewers: uniqueViewers,
        });
      }
    }

    // Unregister socket from registry (cleans up all room tracking)
    socketRegistry.unregisterSocket(socket.id);
    loggers.realtime.info('User disconnected', { socketId: socket.id, reason });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  loggers.realtime.info(`Socket.IO server ready on port ${PORT}`, { port: PORT });
});
