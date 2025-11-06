import { NextRequest, NextResponse } from 'next/server';
import { db, pages, taskMetadata, driveMembers, and, eq } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getUserAccessLevel } from '@pagespace/lib/permissions';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

/**
 * PATCH /api/tasks/[taskId]
 * Update task metadata
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;
  const { taskId } = await context.params;

  try {
    // Get the task page
    const page = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, taskId),
        eq(pages.type, 'TASK'),
        eq(pages.isTrashed, false)
      ),
    });

    if (!page) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Check if user has edit permission
    const accessLevel = await getUserAccessLevel(userId, taskId);
    if (!accessLevel.canEdit) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    const {
      assigneeId,
      status,
      priority,
      dueDate,
      startDate,
      estimatedHours,
      actualHours,
      labels,
      customFields,
    } = await request.json();

    // Validate assigneeId if provided
    if (assigneeId !== undefined) {
      if (assigneeId !== null) {
        const assignee = await db.query.driveMembers.findFirst({
          where: and(
            eq(driveMembers.driveId, page.driveId),
            eq(driveMembers.userId, assigneeId)
          ),
        });

        if (!assignee) {
          return NextResponse.json(
            { error: 'Assignee must be a member of the drive' },
            { status: 400 }
          );
        }
      }
    }

    // Build update data
    const updateData: any = {
      updatedAt: new Date(),
    };

    if (assigneeId !== undefined) updateData.assigneeId = assigneeId;
    if (status !== undefined) {
      updateData.status = status;
      if (status === 'completed') {
        updateData.completedAt = new Date();
      } else if (status !== 'completed') {
        updateData.completedAt = null;
      }
    }
    if (priority !== undefined) updateData.priority = priority;
    if (dueDate !== undefined) updateData.dueDate = dueDate ? new Date(dueDate) : null;
    if (startDate !== undefined) updateData.startDate = startDate ? new Date(startDate) : null;
    if (estimatedHours !== undefined) updateData.estimatedHours = estimatedHours;
    if (actualHours !== undefined) updateData.actualHours = actualHours;
    if (labels !== undefined) updateData.labels = labels;
    if (customFields !== undefined) updateData.customFields = customFields;

    // Update task metadata
    const [updated] = await db
      .update(taskMetadata)
      .set(updateData)
      .where(eq(taskMetadata.pageId, taskId))
      .returning();

    // Also update page updatedAt
    await db
      .update(pages)
      .set({ updatedAt: new Date() })
      .where(eq(pages.id, taskId));

    // Broadcast task update event
    await broadcastPageEvent(
      createPageEventPayload(page.driveId, taskId, 'updated', {
        taskMetadata: updateData,
      })
    );

    return NextResponse.json({ success: true, task: updated });
  } catch (error) {
    loggers.api.error('Error updating task:', error as Error);
    return NextResponse.json({ error: 'Failed to update task' }, { status: 500 });
  }
}

/**
 * GET /api/tasks/[taskId]
 * Get task details with metadata
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, {
    allow: ['jwt', 'mcp'] as const,
    requireCSRF: false,
  });
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;
  const { taskId } = await context.params;

  try {
    // Get the task page
    const page = await db.query.pages.findFirst({
      where: and(
        eq(pages.id, taskId),
        eq(pages.type, 'TASK'),
        eq(pages.isTrashed, false)
      ),
    });

    if (!page) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Check if user has view permission
    const accessLevel = await getUserAccessLevel(userId, taskId);
    if (!accessLevel.canView) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 });
    }

    // Get task metadata
    const metadata = await db.query.taskMetadata.findFirst({
      where: eq(taskMetadata.pageId, taskId),
      with: {
        assignee: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        assigner: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    });

    return NextResponse.json({
      page,
      metadata,
    });
  } catch (error) {
    loggers.api.error('Error getting task:', error as Error);
    return NextResponse.json({ error: 'Failed to get task' }, { status: 500 });
  }
}
