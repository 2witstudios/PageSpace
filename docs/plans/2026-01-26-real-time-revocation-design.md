# Real-Time Permission Revocation Design

**Date:** 2026-01-26
**Status:** Implemented
**Epic:** Critical Real-Time Revocation Continuity

## Problem Statement

**Current behavior:** Users join Socket.IO rooms, then keep receiving updates even after their access is revoked. This violates enterprise security requirements for immediate access revocation.

**Goal:** Implement a zero-trust security model where:
1. Permissions are re-checked for sensitive events
2. Revoked users are immediately kicked from rooms
3. Clients receive graceful notifications about revocation

## Architecture

### Option C: Hybrid Approach (Implemented)

Server-side ejection + client-side graceful handling:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Permission Change Flow                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Web App (API Route)                                            │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 1. Permission revoked (member removed, page unshared, etc.) ││
│  │ 2. Invalidate permission cache                              ││
│  │ 3. Call kick API on realtime service                        ││
│  │ 4. Broadcast member event to user channel                   ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                   │
│                              ▼                                   │
│  Realtime Service (Socket.IO)                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 5. Find user's sockets via SocketRegistry                   ││
│  │ 6. Remove sockets from affected rooms                       ││
│  │ 7. Emit access_revoked event to each socket                 ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                   │
│                              ▼                                   │
│  Client (Browser)                                               │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ 8. useAccessRevocation hook receives event                  ││
│  │ 9. Show toast notification                                  ││
│  │ 10. Redirect to safe location if on revoked resource        ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Socket Registry (`apps/realtime/src/socket-registry.ts`)

Tracks bidirectional mappings:
- `userId → Set<socketId>` (find all sockets for a user)
- `socketId → userId` (find user for a socket)
- `socketId → Set<room>` (find rooms a socket is in)
- `room → Set<socketId>` (find sockets in a room)

### 2. Kick Handler (`apps/realtime/src/kick-handler.ts`)

HTTP API endpoint `/api/kick` that:
- Validates HMAC signature (same as broadcast)
- Accepts userId, roomPattern, reason
- Removes user's sockets from matching rooms
- Emits `access_revoked` event to each socket

### 3. Permission Change Triggers

Integrated into existing API routes:
- `DELETE /api/drives/[driveId]/members/[userId]` - Member removal
- `DELETE /api/pages/[pageId]/permissions` - Page permission revocation
- `POST /api/activities/[activityId]/rollback` - Rollback that revokes access

### 4. Client Handler (`apps/web/src/hooks/useAccessRevocation.ts`)

React hook that:
- Listens for `access_revoked` events
- Shows toast notification with context
- Redirects if user is viewing revoked resource

### 5. Per-Event Authorization (`apps/realtime/src/per-event-auth.ts`)

Zero-trust defense-in-depth:
- Sensitive events (writes) trigger permission re-check
- Read-only events trust room membership
- Fail closed on auth errors

## Event Types

### Kick Reasons

| Reason | Description | Notification |
|--------|-------------|--------------|
| `member_removed` | User removed from drive | "You've been removed from X" |
| `role_changed` | User's role changed | "Your role in X has changed" |
| `permission_revoked` | Page access revoked | "Your access to this page has been revoked" |
| `session_revoked` | Session invalidated | "Please log in again" |

### Sensitive Events (Require Re-Auth)

- `document_update`
- `page_content_change`
- `page_delete`
- `page_move`
- `file_upload`
- `comment_create`
- `comment_delete`
- `task_create`
- `task_update`
- `task_delete`

### Read-Only Events (Trust Room Membership)

- `cursor_move`
- `presence_update`
- `typing_indicator`
- `selection_change`

## Security Properties

1. **Immediate Revocation:** < 5 seconds from permission change to socket ejection
2. **Server Enforced:** Client cannot bypass kick
3. **Graceful UX:** User informed of what happened
4. **Fail Closed:** Auth errors deny access
5. **Defense in Depth:** Per-event re-auth for writes

## Testing

### Unit Tests

- `socket-registry.test.ts` - Registry operations
- `kick-api.test.ts` - API validation and parsing
- `per-event-auth.test.ts` - Sensitive event classification
- `useAccessRevocation.test.ts` - Client hook behavior

### Integration Test Scenario

1. User A joins drive room
2. Admin removes User A from drive
3. User A immediately stops receiving drive updates
4. User A sees "You've been removed" notification
5. User A is redirected to dashboard

## Performance Considerations

- SocketRegistry uses O(1) Set operations
- Kick API is fire-and-forget (doesn't block permission change)
- Per-event auth uses permission cache (L1 memory, L2 Redis)
- Activity room kicks are silent (no user notification)

## Future Enhancements

1. **Metrics:** Track kick counts, latency, reasons
2. **Audit Log:** Record all kicks for compliance
3. **Rate Limiting:** Prevent kick flooding
4. **Reconnection Handling:** Block re-join attempts after kick
