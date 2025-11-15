# Audit Trail Integration Examples

This document provides practical examples of integrating the audit trail and versioning system into PageSpace applications.

## Table of Contents

1. [Basic Page Update with Audit Trail](#basic-page-update-with-audit-trail)
2. [AI-Initiated Content Generation](#ai-initiated-content-generation)
3. [Bulk Operations](#bulk-operations)
4. [Activity Feed API](#activity-feed-api)
5. [Version History API](#version-history-api)
6. [Admin Reports](#admin-reports)
7. [Real-time Activity Updates](#real-time-activity-updates)

## Basic Page Update with Audit Trail

### API Route: Update Page Content

```typescript
// apps/web/src/app/api/pages/[id]/route.ts
import { NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';
import {
  createAuditEvent,
  createPageVersion,
  computeChanges,
} from '@pagespace/lib/audit';
import { getCurrentUser } from '@/lib/auth';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id: pageId } = await context.params;
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { content, title } = body;

  // Get current page state
  const currentPage = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
  });

  if (!currentPage) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  // Update the page
  const [updatedPage] = await db
    .update(pages)
    .set({
      content: content !== undefined ? content : currentPage.content,
      title: title !== undefined ? title : currentPage.title,
      updatedAt: new Date(),
    })
    .where(eq(pages.id, pageId))
    .returning();

  // Compute what changed
  const beforeState = {
    content: currentPage.content,
    title: currentPage.title,
  };

  const afterState = {
    content: updatedPage.content,
    title: updatedPage.title,
  };

  const changes = computeChanges(beforeState, afterState);

  // Create audit event
  const auditEvent = await createAuditEvent({
    actionType: 'PAGE_UPDATE',
    entityType: 'PAGE',
    entityId: pageId,
    userId: user.id,
    driveId: currentPage.driveId,
    beforeState,
    afterState,
    changes,
    description: `Updated page "${currentPage.title}"`,
    reason: 'User edited the page',
    ipAddress: request.headers.get('x-forwarded-for') || undefined,
    userAgent: request.headers.get('user-agent') || undefined,
  });

  // Create version snapshot if content changed
  if (content !== undefined && content !== currentPage.content) {
    await createPageVersion({
      pageId,
      auditEventId: auditEvent.id,
      userId: user.id,
      isAiGenerated: false,
      changeSummary: 'User edited content',
      changeType: 'user_edit',
    });
  }

  return NextResponse.json({
    success: true,
    page: updatedPage,
    auditEventId: auditEvent.id,
  });
}
```

## AI-Initiated Content Generation

### API Route: AI Content Generation

```typescript
// apps/web/src/app/api/ai/generate-content/route.ts
import { NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';
import {
  trackAiOperation,
  createAuditEvent,
  createPageVersion,
} from '@pagespace/lib/audit';
import { getCurrentUser } from '@/lib/auth';
import { streamText } from 'ai';
import { getModelProvider } from '@/lib/ai/provider-factory';

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { pageId, prompt, provider, model } = await request.json();

  // Get page
  const page = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
  });

  if (!page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  // Start tracking AI operation
  const aiOperation = await trackAiOperation({
    userId: user.id,
    agentType: 'EDITOR',
    provider,
    model,
    operationType: 'generate',
    prompt,
    driveId: page.driveId,
    pageId,
  });

  try {
    // Generate content
    const modelClient = getModelProvider(provider, model);
    const result = await streamText({
      model: modelClient,
      prompt: `Generate content based on this request: ${prompt}`,
    });

    const generatedContent = await result.text;

    // Update page with generated content
    const beforeState = { content: page.content };
    const [updatedPage] = await db
      .update(pages)
      .set({
        content: generatedContent,
        updatedAt: new Date(),
      })
      .where(eq(pages.id, pageId))
      .returning();

    const afterState = { content: generatedContent };

    // Create audit event
    const auditEvent = await createAuditEvent({
      actionType: 'AI_GENERATE',
      entityType: 'PAGE',
      entityId: pageId,
      userId: user.id,
      isAiAction: true,
      aiOperationId: aiOperation.id,
      driveId: page.driveId,
      beforeState,
      afterState,
      changes: {
        content: { before: page.content, after: generatedContent },
      },
      description: `AI generated content for "${page.title}"`,
      reason: prompt,
    });

    // Create version
    await createPageVersion({
      pageId,
      auditEventId: auditEvent.id,
      userId: user.id,
      isAiGenerated: true,
      changeSummary: `AI generated: ${prompt.substring(0, 100)}...`,
      changeType: 'ai_edit',
    });

    // Mark AI operation as complete
    await aiOperation.complete({
      completion: generatedContent,
      actionsPerformed: { updatedPages: [pageId] },
      tokens: {
        input: result.usage?.promptTokens || 0,
        output: result.usage?.completionTokens || 0,
        cost: 0, // Calculate based on provider pricing
      },
    });

    return NextResponse.json({
      success: true,
      content: generatedContent,
      page: updatedPage,
    });
  } catch (error: any) {
    // Mark operation as failed
    await aiOperation.fail(error.message);

    return NextResponse.json(
      { error: 'Failed to generate content' },
      { status: 500 }
    );
  }
}
```

## Bulk Operations

### Example: Moving Multiple Pages

```typescript
// apps/web/src/app/api/pages/bulk-move/route.ts
import { NextResponse } from 'next/server';
import { db, pages, eq } from '@pagespace/db';
import { createBulkAuditEvents } from '@pagespace/lib/audit';
import { getCurrentUser } from '@/lib/auth';
import { createId } from '@paralleldrive/cuid2';

export async function POST(request: Request) {
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { pageIds, newParentId } = await request.json();

  // Create operation ID to group all related changes
  const operationId = createId();

  // Fetch current states
  const pagesToMove = await Promise.all(
    pageIds.map((id: string) =>
      db.query.pages.findFirst({ where: eq(pages.id, id) })
    )
  );

  // Update all pages
  const updatePromises = pagesToMove.map((page) => {
    if (!page) return null;
    return db
      .update(pages)
      .set({ parentId: newParentId, updatedAt: new Date() })
      .where(eq(pages.id, page.id))
      .returning();
  });

  const updatedPages = await Promise.all(updatePromises);

  // Create bulk audit events
  const auditEvents = pagesToMove.map((page) => {
    if (!page) return null;
    return {
      actionType: 'PAGE_MOVE' as const,
      entityType: 'PAGE' as const,
      entityId: page.id,
      userId: user.id,
      driveId: page.driveId,
      beforeState: { parentId: page.parentId },
      afterState: { parentId: newParentId },
      changes: {
        parentId: { before: page.parentId, after: newParentId },
      },
      description: `Moved "${page.title}" to new parent`,
      operationId, // Link all events together
    };
  });

  await createBulkAuditEvents(auditEvents.filter(Boolean) as any);

  return NextResponse.json({
    success: true,
    movedCount: pageIds.length,
    operationId,
  });
}
```

## Activity Feed API

### Route: Get Drive Activity

```typescript
// apps/web/src/app/api/drives/[driveId]/activity/route.ts
import { NextResponse } from 'next/server';
import { getDriveActivityFeed } from '@pagespace/lib/audit';
import { getCurrentUser } from '@/lib/auth';
import { getUserAccessLevel } from '@pagespace/lib/permissions';

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  const { driveId } = await context.params;
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check access
  const accessLevel = await getUserAccessLevel(user.id, driveId);
  if (!accessLevel) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get('limit') || '50');
  const filter = searchParams.get('filter'); // 'ai', 'human', or undefined

  let activity;
  if (filter === 'ai') {
    const { getDriveAiActivity } = await import('@pagespace/lib/audit');
    activity = await getDriveAiActivity(driveId, limit);
  } else if (filter === 'human') {
    const { getDriveHumanActivity } = await import('@pagespace/lib/audit');
    activity = await getDriveHumanActivity(driveId, limit);
  } else {
    activity = await getDriveActivityFeed(driveId, limit);
  }

  return NextResponse.json({ activity });
}
```

### Component: Activity Feed

```typescript
// apps/web/src/components/activity-feed.tsx
'use client';

import { useEffect, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';

interface ActivityEvent {
  id: string;
  actionType: string;
  description: string;
  createdAt: Date;
  user?: { name: string; image: string };
  aiOperation?: { agentType: string; model: string };
  isAiAction: boolean;
}

export function ActivityFeed({ driveId }: { driveId: string }) {
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [filter, setFilter] = useState<'all' | 'ai' | 'human'>('all');

  useEffect(() => {
    async function fetchActivity() {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('filter', filter);

      const response = await fetch(
        `/api/drives/${driveId}/activity?${params}`
      );
      const data = await response.json();
      setActivity(data.activity);
    }

    fetchActivity();
  }, [driveId, filter]);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          onClick={() => setFilter('all')}
          className={filter === 'all' ? 'font-bold' : ''}
        >
          All
        </button>
        <button
          onClick={() => setFilter('ai')}
          className={filter === 'ai' ? 'font-bold' : ''}
        >
          AI Actions
        </button>
        <button
          onClick={() => setFilter('human')}
          className={filter === 'human' ? 'font-bold' : ''}
        >
          Human Actions
        </button>
      </div>

      <div className="space-y-2">
        {activity.map((event) => (
          <div key={event.id} className="border p-3 rounded">
            <div className="flex items-center gap-2">
              {event.isAiAction ? (
                <span className="text-blue-500">🤖 AI</span>
              ) : (
                <span>{event.user?.name || 'Unknown User'}</span>
              )}
              <span className="text-sm text-gray-500">
                {formatDistanceToNow(new Date(event.createdAt), {
                  addSuffix: true,
                })}
              </span>
            </div>
            <p className="mt-1">{event.description}</p>
            {event.aiOperation && (
              <p className="text-xs text-gray-500 mt-1">
                {event.aiOperation.agentType} • {event.aiOperation.model}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

## Version History API

### Route: Get Page Versions

```typescript
// apps/web/src/app/api/pages/[pageId]/versions/route.ts
import { NextResponse } from 'next/server';
import { getPageVersions } from '@pagespace/lib/audit';
import { getCurrentUser } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions';

export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await context.params;
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check access
  const canView = await canUserViewPage(user.id, pageId);
  if (!canView) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const versions = await getPageVersions(pageId);

  return NextResponse.json({ versions });
}
```

### Route: Restore Version

```typescript
// apps/web/src/app/api/pages/[pageId]/versions/[versionNumber]/restore/route.ts
import { NextResponse } from 'next/server';
import { restorePageVersion } from '@pagespace/lib/audit';
import { getCurrentUser } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions';

export async function POST(
  request: Request,
  context: { params: Promise<{ pageId: string; versionNumber: string }> }
) {
  const { pageId, versionNumber } = await context.params;
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check edit permission
  const canEdit = await canUserEditPage(user.id, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const restoredPage = await restorePageVersion(
      pageId,
      parseInt(versionNumber),
      user.id
    );

    return NextResponse.json({
      success: true,
      page: restoredPage,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message },
      { status: 400 }
    );
  }
}
```

## Admin Reports

### Route: AI Usage Report

```typescript
// apps/web/src/app/api/admin/ai-usage-report/route.ts
import { NextResponse } from 'next/server';
import { getAiUsageReport } from '@pagespace/lib/audit';
import { getCurrentUser } from '@/lib/auth';

export async function GET(request: Request) {
  const user = await getCurrentUser();

  if (!user || user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId') || user.id;
  const days = parseInt(searchParams.get('days') || '30');

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const report = await getAiUsageReport(userId, startDate, endDate);

  return NextResponse.json({ report });
}
```

### Route: Drive Activity Stats

```typescript
// apps/web/src/app/api/drives/[driveId]/stats/route.ts
import { NextResponse } from 'next/server';
import { getDriveActivityStats } from '@pagespace/lib/audit';
import { getCurrentUser } from '@/lib/auth';
import { getUserAccessLevel } from '@pagespace/lib/permissions';

export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  const { driveId } = await context.params;
  const user = await getCurrentUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Check access
  const accessLevel = await getUserAccessLevel(user.id, driveId);
  if (!accessLevel) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get('days') || '30');

  const stats = await getDriveActivityStats(driveId, days);

  return NextResponse.json({ stats });
}
```

## Real-time Activity Updates

### Using Socket.IO for Live Activity Feed

```typescript
// apps/realtime/src/handlers/audit-events.ts
import { Server } from 'socket.io';
import { createClient } from 'pg';

export function setupAuditEventNotifications(io: Server) {
  const pgClient = createClient({
    connectionString: process.env.DATABASE_URL,
  });

  pgClient.connect();

  // Listen for PostgreSQL notifications
  pgClient.query('LISTEN audit_events_channel');

  pgClient.on('notification', (msg) => {
    if (msg.channel === 'audit_events_channel') {
      const event = JSON.parse(msg.payload || '{}');

      // Broadcast to all users in the drive room
      if (event.driveId) {
        io.to(`drive:${event.driveId}`).emit('audit_event', event);
      }
    }
  });
}
```

### PostgreSQL Trigger for Notifications

```sql
-- Add to migration
CREATE OR REPLACE FUNCTION notify_audit_event()
RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('audit_events_channel', json_build_object(
    'id', NEW.id,
    'driveId', NEW.drive_id,
    'actionType', NEW.action_type,
    'entityType', NEW.entity_type,
    'entityId', NEW.entity_id,
    'userId', NEW.user_id,
    'isAiAction', NEW.is_ai_action,
    'description', NEW.description,
    'createdAt', NEW.created_at
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_notify
AFTER INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION notify_audit_event();
```

### Client Component: Live Activity Feed

```typescript
// apps/web/src/components/live-activity-feed.tsx
'use client';

import { useEffect, useState } from 'react';
import { useSocket } from '@/hooks/use-socket';

export function LiveActivityFeed({ driveId }: { driveId: string }) {
  const [events, setEvents] = useState<any[]>([]);
  const socket = useSocket();

  useEffect(() => {
    if (!socket) return;

    // Join drive room
    socket.emit('join_drive', driveId);

    // Listen for new audit events
    socket.on('audit_event', (event) => {
      setEvents((prev) => [event, ...prev].slice(0, 50));
    });

    return () => {
      socket.off('audit_event');
      socket.emit('leave_drive', driveId);
    };
  }, [socket, driveId]);

  return (
    <div className="space-y-2">
      {events.map((event) => (
        <div key={event.id} className="border p-2 rounded animate-fade-in">
          <span className="font-semibold">{event.actionType}</span>
          <p className="text-sm">{event.description}</p>
        </div>
      ))}
    </div>
  );
}
```

## Summary

These examples demonstrate:

1. **Basic Integration**: Adding audit trail to existing CRUD operations
2. **AI Attribution**: Tracking AI operations with full context
3. **Bulk Operations**: Grouping related changes with operationId
4. **Activity Feeds**: Querying and displaying audit events
5. **Version History**: Managing and restoring page versions
6. **Admin Reports**: Analyzing AI usage and drive activity
7. **Real-time Updates**: Live activity feeds with Socket.IO

The audit trail system integrates seamlessly with existing PageSpace operations while providing comprehensive tracking and attribution.
