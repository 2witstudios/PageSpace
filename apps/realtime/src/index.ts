import { createServer, IncomingMessage, ServerResponse } from 'http';
import { Server, Socket } from 'socket.io';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib';
import { decodeToken } from '@pagespace/lib/server';
import * as dotenv from 'dotenv';
import { db, eq, or } from '@pagespace/db';
import { users } from '@pagespace/db/src/schema/auth';
import { dmConversations } from '@pagespace/db/src/schema/social';
import { parse } from 'cookie';
import { loggers } from '@pagespace/lib/logger-config';

dotenv.config({ path: '../../.env' });

const requestListener = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/api/broadcast') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const { channelId, event, payload } = JSON.parse(body);
                if (channelId && event && payload) {
                    io.to(channelId).emit(event, payload);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid broadcast payload' }));
                }
            } catch (error) {
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
  // Debug: Log all available authentication sources
  loggers.realtime.debug('Socket.IO: Authentication attempt', {
    authField: !!socket.handshake.auth.token,
    authTokenLength: socket.handshake.auth.token?.length || 0,
    hasCookieHeader: !!socket.handshake.headers.cookie,
    cookieHeader: socket.handshake.headers.cookie ? 'present' : 'missing',
    origin: socket.handshake.headers.origin,
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

  socket.on('disconnect', (reason) => {
    loggers.realtime.info('User disconnected', { socketId: socket.id, reason });
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  loggers.realtime.info(`Socket.IO server ready on port ${PORT}`, { port: PORT });
});
