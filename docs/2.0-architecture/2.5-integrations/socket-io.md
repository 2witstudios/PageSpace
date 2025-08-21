# Integration: Socket.IO

This document outlines how pagespace integrates with Socket.IO for real-time communication.

## Architecture Overview

pagespace uses a dedicated, standalone Socket.IO server for handling real-time, event-based communication. This server runs as a separate Node.js process, distinct from the main Next.js web application. This separation ensures that long-lived, stateful socket connections do not interfere with the stateless, serverless-first nature of the Next.js application.

-   **Realtime Server (`apps/realtime`):** A standalone Node.js application responsible for managing all WebSocket connections, authentication, and event broadcasting.
-   **Web Client (`apps/web`):** The main Next.js application connects to the realtime server as a client to send and receive live updates.
-   **Backend-to-Realtime Communication:** When a backend API route in the Next.js app needs to trigger a real-time event, it makes an HTTP POST request to a special `/api/broadcast` endpoint on the realtime server. The realtime server then broadcasts the message to the appropriate clients.

## Server-Side Implementation (`apps/realtime`)

The entire server-side logic is contained within [`apps/realtime/src/index.ts`](apps/realtime/src/index.ts:1).

### 1. Server Initialization

The server is a standard Node.js HTTP server with Socket.IO attached. The CORS configuration is set to allow connections from our web application's URL, which is defined by the `CORS_ORIGIN` environment variable.

```typescript
// apps/realtime/src/index.ts
const httpServer = createServer(requestListener);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  },
});
```

### 2. Authentication Middleware

Connections are authenticated using a custom middleware that supports multiple token sources. The client can send a JWT (`accessToken`) in:
- `socket.handshake.auth.token` field
- HTTP cookies (for httpOnly cookies)

The middleware performs the following checks:
1.  Attempts to extract the token from auth field first, then falls back to cookies
2.  Decodes the token using the shared `@pagespace/lib` utility
3.  Verifies the user exists in the database
4.  Checks the `tokenVersion` to ensure the token hasn't been invalidated by a password change or logout
5.  Logs authentication attempts and results for debugging

If authentication is successful, the user's ID is attached to the `socket.data` object for use in subsequent events.

```typescript
// apps/realtime/src/index.ts
io.use(async (socket: AuthSocket, next) => {
  const { token } = socket.handshake.auth;
  // ... authentication logic ...
  socket.data.user = { id: user.id };
  next();
});
```

### 3. Event Handling

-   **Auto-join notification room:** Upon connection, users are automatically joined to their personal notification room (`notifications:${userId}`)
-   **`join_channel`:** Client emits with a `pageId`. Server verifies user has access via `getUserAccessLevel()` before joining the room
-   **`join_drive`:** Client emits with a `driveId`. Server verifies access via `getUserDriveAccess()` before joining `drive:${driveId}` room
-   **`leave_drive`:** Client leaves a specific drive room
-   **`join_global_drives`:** Client joins the global drives room for system-wide drive updates
-   **`leave_global_drives`:** Client leaves the global drives room
-   **`disconnect`:** Standard event for logging when a user disconnects

### 4. Broadcast Endpoint (`/api/broadcast`)

To allow the main Next.js backend to trigger events, the realtime server exposes a simple HTTP endpoint. The backend can send a POST request with a `channelId`, `event` name, and `payload`. The realtime server then broadcasts this payload to all clients in the specified channel.

This is used for multiple events including:
- `new_message` events in channels
- `notification:new` events for user notifications
- Drive-related events for real-time collaboration

## Client-Side Implementation (`apps/web`)

The primary client-side implementation can be found in the [`ChannelView.tsx`](apps/web/src/components/layout/middle-content/page-views/channel/ChannelView.tsx:1) component.

### 1. Establishing a Connection

The client connects to the realtime server using the URL from the `NEXT_PUBLIC_REALTIME_URL` environment variable. It retrieves the `accessToken` from the browser's cookies and sends it in the `auth` payload for the authentication middleware.

```typescript
// apps/web/src/components/layout/middle-content/page-views/channel/ChannelView.tsx
useEffect(() => {
  if (!user) return;

  const socketUrl = process.env.NEXT_PUBLIC_REALTIME_URL;
  const socket = io(socketUrl, {
    auth: {
      token: document.cookie
        .split('; ')
        .find(row => row.startsWith('accessToken='))
        ?.split('=')[1],
    },
  });
  socketRef.current = socket;
  // ...
}, [page.id, user]);
```

### 2. Joining Channels and Handling Events

Once connected, the client immediately emits the `join_channel` event. It then sets up a listener for the `new_message` event to receive and display new messages in real-time.

```typescript
// apps/web/src/components/layout/middle-content/page-views/channel/ChannelView.tsx
socket.emit('join_channel', page.id);

const handleNewMessage = (message: MessageWithUser) => {
  setMessages((prev) => [...prev, message]);
};

socket.on('new_message', handleNewMessage);
```

## Event Reference

| Event Name              | Direction           | Description                                                                                             |
| ----------------------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `join_channel`          | Client → Server     | Requests to join a specific page's room. Server validates permissions before allowing the join.         |
| `join_drive`            | Client → Server     | Requests to join a drive room. Server validates drive access before allowing the join.                 |
| `leave_drive`           | Client → Server     | Leaves a specific drive room.                                                                           |
| `join_global_drives`    | Client → Server     | Joins the global drives room for system-wide updates.                                                  |
| `leave_global_drives`   | Client → Server     | Leaves the global drives room.                                                                          |
| `new_message`           | Server → Client     | Broadcasts a new message to all clients in a specific channel room.                                     |
| `notification:new`      | Server → Client     | Broadcasts a new notification to a user's personal notification room.                                  |

## Environment Variables

To run the real-time system locally, ensure the following variables are set:

-   **Realtime Server Environment Variables:**
    -   `CORS_ORIGIN` or `WEB_APP_URL`: The full URL of the web client (e.g., `http://localhost:3000`)
    -   `PORT`: The port for the realtime server to run on (e.g., `3001`)
    -   `INTERNAL_REALTIME_URL`: Internal URL for server-to-server communication (e.g., `http://localhost:3001`)
-   **Web Client Environment Variables:**
    -   `NEXT_PUBLIC_REALTIME_URL`: The full URL of the realtime server (e.g., `http://localhost:3001`)
## Notification System Integration

The Socket.IO implementation includes a comprehensive notification system:

-   **Personal notification rooms:** Each user automatically joins `notifications:${userId}` upon connection
-   **Broadcast function:** `@pagespace/lib/notifications` provides `broadcastNotification()` for sending real-time notifications
-   **Notification types:** Permission changes, drive invitations, role updates, and more
-   **Auto-broadcasting:** Database notification creation automatically triggers real-time broadcasts

## Logging & Debugging

The realtime server includes comprehensive logging via `@pagespace/lib/logger-config`:

-   Authentication attempts and results
-   Room joins/leaves for channels and drives
-   Connection and disconnection events
-   Error handling and debugging information

**Last Updated:** 2025-08-21