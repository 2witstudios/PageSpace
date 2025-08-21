# Notifications API

## Overview

The Notifications API provides real-time notification management for user activities, mentions, and system events within PageSpace. Notifications are delivered through both in-app interfaces and real-time websocket connections, enabling users to stay informed about workspace activities.

## API Routes

### GET /api/notifications

**Purpose:** Retrieves notifications for the authenticated user.
**Auth Required:** Yes
**Request Schema:**
- limit: number (query parameter - optional, default 50)
- countOnly: boolean (query parameter - optional, returns only unread count)
**Response Schema:** 
- notifications: Array of notification objects
- unreadCount: number
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### GET /api/notifications/[id]

**Purpose:** Retrieves a specific notification.
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** Notification object.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### PATCH /api/notifications/[id]

**Purpose:** Updates notification metadata (mark as read/unread).
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
- isRead: boolean
**Response Schema:** Updated notification object.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Updates readAt timestamp when marked as read
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### DELETE /api/notifications/[id]

**Purpose:** Deletes a specific notification.
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** Success message.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Permanent deletion of notification
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### POST /api/notifications/[id]/read

**Purpose:** Marks a notification as read.
**Auth Required:** Yes
**Request Schema:**
- id: string (dynamic parameter - must await context.params in Next.js 15)
**Response Schema:** Success message.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Updates readAt timestamp
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

### POST /api/notifications/read-all

**Purpose:** Marks all notifications as read for the authenticated user.
**Auth Required:** Yes
**Request Schema:** None
**Response Schema:** Success message with count of updated notifications.
**Status Codes:** 200 (OK), 401 (Unauthorized), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

## Database Schema

### notifications Table

```sql
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,              -- Notification UUID
  userId TEXT NOT NULL,             -- Target user ID (FK to users.id)
  type TEXT NOT NULL,               -- Notification type
  title TEXT NOT NULL,              -- Notification headline
  message TEXT,                     -- Detailed notification content
  data JSONB,                       -- Additional structured data
  readAt TIMESTAMP,                 -- When notification was read (NULL = unread)
  createdAt TIMESTAMP NOT NULL,     -- When notification was created
  updatedAt TIMESTAMP NOT NULL      -- Last update timestamp
);

-- Indexes for efficient queries
CREATE INDEX notifications_user_id_idx ON notifications(userId);
CREATE INDEX notifications_user_id_read_at_idx ON notifications(userId, readAt);
CREATE INDEX notifications_user_id_created_at_idx ON notifications(userId, createdAt DESC);
```

## Notification Types

### Mention Notifications
- **Type:** `mention`
- **Triggered:** When user is mentioned in pages, comments, or AI conversations
- **Data:** `{ pageId, mentionedBy, pageTitle, pageType }`

### Drive Invitations
- **Type:** `drive_invitation`
- **Triggered:** When user is invited to join a drive
- **Data:** `{ driveId, driveName, invitedBy, role }`

### Permission Changes
- **Type:** `permission_change`
- **Triggered:** When user's permissions are modified
- **Data:** `{ pageId, pageTitle, newPermission, changedBy }`

### System Notifications
- **Type:** `system`
- **Triggered:** System-wide announcements or important updates
- **Data:** `{ category, priority, actionUrl }`

## Real-Time Integration

Notifications integrate with the Socket.IO real-time system to provide instant delivery:

```typescript
// Server-side notification broadcast
io.to(`user:${userId}`).emit('notification', {
  id: notification.id,
  type: notification.type,
  title: notification.title,
  message: notification.message,
  createdAt: notification.createdAt
});
```

## Permission Model

- **User Scope:** Users can only access their own notifications
- **Admin Access:** System administrators can view all notifications for debugging
- **Privacy:** Notification content respects page-level permissions