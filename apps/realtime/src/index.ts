import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Server, Socket } from 'socket.io';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/permissions-cached';
import { decodeToken } from '@pagespace/lib/server';
import { verifyBroadcastSignature } from '@pagespace/lib/broadcast-auth';
import * as dotenv from 'dotenv';
import { db, eq, or, users, dmConversations } from '@pagespace/db';
import { parse } from 'cookie';
import { loggers } from '@pagespace/lib/logger-config';

dotenv.config({ path: '../../.env' });

/**
 * Origin Validation for WebSocket Connections (Defense-in-Depth Logging)
 *
 * While Socket.IO CORS configuration handles blocking unauthorized origins,
 * this module provides explicit logging for security monitoring.
 * Warnings are logged for unexpected origins to aid in detecting potential attacks.
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
 * Validates and logs WebSocket connection origin for security monitoring
 *
 * This function does NOT block connections - Socket.IO CORS handles that.
 * It provides explicit logging for unexpected origins to aid security monitoring.
 *
 * @param origin - The Origin header value from the connection request
 * @param metadata - Additional metadata for logging (socketId, IP, etc.)
 */
function validateAndLogWebSocketOrigin(
  origin: string | undefined,
  metadata: { socketId: string; ip: string | undefined; userAgent: string | undefined }
): void {
  const allowedOrigins = getAllowedOrigins();

  // No origin header - could be non-browser client, log at debug level
  if (!origin) {
    loggers.realtime.debug('WebSocket origin validation: no Origin header', {
      ...metadata,
      reason: 'Non-browser client or same-origin request',
    });
    return;
  }

  // No allowed origins configured - log warning
  if (allowedOrigins.length === 0) {
    loggers.realtime.warn('WebSocket origin validation: no allowed origins configured', {
      ...metadata,
      origin,
      reason: 'CORS_ORIGIN and WEB_APP_URL not set',
    });
    return;
  }

  // Check if origin is allowed
  if (isOriginAllowed(origin, allowedOrigins)) {
    loggers.realtime.debug('WebSocket origin validation: valid origin', {
      ...metadata,
      origin,
    });
    return;
  }

  // Origin not in allowed list - log security warning
  // Note: Socket.IO CORS will block this connection, but we log for monitoring
  loggers.realtime.warn('WebSocket origin validation: unexpected origin detected', {
    ...metadata,
    origin,
    allowedOrigins,
    severity: 'security',
    reason: 'Origin not in allowed list - connection may be blocked by CORS',
  });
}

const requestListener = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/api/broadcast') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                // Verify HMAC signature before processing
                const signatureHeader = req.headers['x-broadcast-signature'] as string;
                if (!signatureHeader) {
                    loggers.realtime.warn('Broadcast request missing signature header', {
                        ip: req.socket.remoteAddress,
                        userAgent: req.headers['user-agent']
                    });
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Authentication required' }));
                    return;
                }

                if (!verifyBroadcastSignature(signatureHeader, body)) {
                    loggers.realtime.error('Broadcast request signature verification failed', {
                        ip: req.socket.remoteAddress,
                        userAgent: req.headers['user-agent'],
                        hasSignature: !!signatureHeader,
                        bodyLength: body.length
                    });
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
    };
  };
}

io.use(async (socket: AuthSocket, next) => {
  // Extract connection metadata for logging
  const connectionMetadata = {
    socketId: socket.id,
    ip: socket.handshake.address,
    userAgent: socket.handshake.headers['user-agent']?.substring(0, 100),
  };

  // Validate and log Origin header for security monitoring
  // Note: Socket.IO CORS configuration handles actual blocking
  const origin = socket.handshake.headers.origin;
  validateAndLogWebSocketOrigin(origin, connectionMetadata);

  // Debug: Log all available authentication sources
  loggers.realtime.debug('Socket.IO: Authentication attempt', {
    authField: !!socket.handshake.auth.token,
    authTokenLength: socket.handshake.auth.token?.length || 0,
    hasCookieHeader: !!socket.handshake.headers.cookie,
    cookieHeader: socket.handshake.headers.cookie ? 'present' : 'missing',
    origin: origin,
    userAgent: socket.handshake.headers['user-agent']?.substring(0, 50)
  });

  // Try to get token from auth field first
  let token = socket.handshake.auth.token;
  
  // If no token in auth field, try to get it from cookies (for httpOnly cookies)
  if (!token && socket.handshake.headers.cookie) {
    try {
      const cookies = parse(socket.handshake.headers.cookie);
      
      loggers.realtime.debug('Socket.IO: Parsed cookies', {
        cookieKeys: Object.keys(cookies),
        hasAccessToken: !!cookies.accessToken,
        accessTokenLength: cookies.accessToken?.length || 0
      });
      
      token = cookies.accessToken;
      if (token) {
        loggers.realtime.debug('Socket.IO: Using accessToken from httpOnly cookie');
      }
    } catch (error) {
      loggers.realtime.error('Failed to parse cookies', error as Error);
    }
  }

  if (!token) {
    loggers.realtime.warn('Socket.IO: No token found in auth field or cookies', {
      authFieldEmpty: !socket.handshake.auth.token,
      cookieHeaderMissing: !socket.handshake.headers.cookie
    });
    return next(new Error('Authentication error: No token provided.'));
  }

  const decoded = await decodeToken(token);
  if (!decoded) {
    loggers.realtime.warn('Socket.IO: Token validation failed');
    return next(new Error('Authentication error: Invalid token.'));
  }

  try {
    const user = await db.query.users.findFirst({
        where: eq(users.id, decoded.userId),
        columns: {
            id: true,
            tokenVersion: true,
        },
    });

    if (!user || user.tokenVersion !== decoded.tokenVersion) {
      return next(new Error('Authentication error: Invalid token version.'));
    }

    socket.data.user = { id: user.id };
    loggers.realtime.info('Socket.IO: User authenticated successfully', { userId: user.id });
    next();
  } catch (error) {
    loggers.realtime.error('Error during authentication', error as Error);
    return next(new Error('Authentication error: Server failed.'));
  }
});

io.on('connection', (socket: AuthSocket) => {
  loggers.realtime.info('User connected', { socketId: socket.id });
  const user = socket.data.user;

  // Auto-join user's notification room and task room
  if (user?.id) {
    const notificationRoom = `notifications:${user.id}`;
    const taskRoom = `user:${user.id}:tasks`;
    socket.join(notificationRoom);
    socket.join(taskRoom);
    loggers.realtime.debug('User joined notification and task rooms', { 
      userId: user.id, 
      rooms: [notificationRoom, taskRoom] 
    });
  }

  socket.on('join_channel', async (pageId: string) => {
    if (!user?.id) return;

    try {
      const accessLevel = await getUserAccessLevel(user.id, pageId);
      if (accessLevel) {
        socket.join(pageId);
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

  socket.on('join_drive', async (driveId: string) => {
    if (!user?.id) return;

    try {
      const hasAccess = await getUserDriveAccess(user.id, driveId);
      if (hasAccess) {
        const driveRoom = `drive:${driveId}`;
        socket.join(driveRoom);
        loggers.realtime.debug('User joined drive room', { userId: user.id, room: driveRoom });
      } else {
        loggers.realtime.warn('User denied access to drive', { userId: user.id, driveId });
      }
    } catch (error) {
      loggers.realtime.error('Error joining drive', error as Error, { driveId });
    }
  });

  // Join a direct message conversation room after membership verification
  socket.on('join_dm_conversation', async (conversationId: string) => {
    const userId = user?.id;
    if (!userId || !conversationId) return;

    try {
      const [conversation] = await db
        .select()
        .from(dmConversations)
        .where(
          eq(dmConversations.id, conversationId as string)
        )
        .limit(1);

      if (!conversation || (conversation.participant1Id !== userId && conversation.participant2Id !== userId)) {
        loggers.realtime.warn('DM join denied: not a participant', { userId, conversationId });
        return;
      }

      const room = `dm:${conversationId}`;
      socket.join(room);
      loggers.realtime.debug('User joined DM room', { userId, room });
    } catch (error) {
      loggers.realtime.error('Error joining DM conversation', error as Error, { conversationId });
    }
  });

  socket.on('leave_dm_conversation', (conversationId: string) => {
    const userId = user?.id;
    if (!userId || !conversationId) return;

    const room = `dm:${conversationId}`;
    socket.leave(room);
    loggers.realtime.debug('User left DM room', { userId, room });
  });

  socket.on('leave_drive', (driveId: string) => {
    if (!user?.id) return;
    
    const driveRoom = `drive:${driveId}`;
    socket.leave(driveRoom);
    loggers.realtime.debug('User left drive room', { userId: user.id, room: driveRoom });
  });

  socket.on('join_global_drives', () => {
    if (!user?.id) return;
    
    const globalDrivesRoom = 'global:drives';
    socket.join(globalDrivesRoom);
    loggers.realtime.debug('User joined global drives room', { userId: user.id, room: globalDrivesRoom });
  });

  socket.on('leave_global_drives', () => {
    if (!user?.id) return;

    const globalDrivesRoom = 'global:drives';
    socket.leave(globalDrivesRoom);
    loggers.realtime.debug('User left global drives room', { userId: user.id, room: globalDrivesRoom });
  });

  // Activity channel handlers - for real-time activity feed updates
  socket.on('join_activity_drive', async (driveId: string) => {
    if (!user?.id) return;

    try {
      const hasAccess = await getUserDriveAccess(user.id, driveId);
      if (hasAccess) {
        const activityRoom = `activity:drive:${driveId}`;
        socket.join(activityRoom);
        loggers.realtime.debug('User joined activity drive room', { userId: user.id, room: activityRoom });
      } else {
        loggers.realtime.warn('User denied access to activity drive', { userId: user.id, driveId });
      }
    } catch (error) {
      loggers.realtime.error('Error joining activity drive', error as Error, { driveId });
    }
  });

  socket.on('join_activity_page', async (pageId: string) => {
    if (!user?.id) return;

    try {
      const accessLevel = await getUserAccessLevel(user.id, pageId);
      if (accessLevel) {
        const activityRoom = `activity:page:${pageId}`;
        socket.join(activityRoom);
        loggers.realtime.debug('User joined activity page room', { userId: user.id, room: activityRoom });
      } else {
        loggers.realtime.warn('User denied access to activity page', { userId: user.id, pageId });
      }
    } catch (error) {
      loggers.realtime.error('Error joining activity page', error as Error, { pageId });
    }
  });

  socket.on('leave_activity_drive', (driveId: string) => {
    if (!user?.id) return;

    const activityRoom = `activity:drive:${driveId}`;
    socket.leave(activityRoom);
    loggers.realtime.debug('User left activity drive room', { userId: user.id, room: activityRoom });
  });

  socket.on('leave_activity_page', (pageId: string) => {
    if (!user?.id) return;

    const activityRoom = `activity:page:${pageId}`;
    socket.leave(activityRoom);
    loggers.realtime.debug('User left activity page room', { userId: user.id, room: activityRoom });
  });

  socket.on('disconnect', (reason) => {
    loggers.realtime.info('User disconnected', { socketId: socket.id, reason });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  loggers.realtime.info(`Socket.IO server ready on port ${PORT}`, { port: PORT });
});
