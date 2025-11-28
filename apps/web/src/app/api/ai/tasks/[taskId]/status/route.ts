import { NextRequest, NextResponse } from 'next/server';
import { db, aiTasks, eq, and, sql } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { broadcastTaskEvent } from '@/lib/websocket/socket-utils';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> }
) {
  try {
    const { taskId } = await context.params;
    const { status, note } = await request.json();

    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Validate status
    const validStatuses = ['pending', 'in_progress', 'completed', 'blocked'];
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') },
        { status: 400 }
      );
    }

    // Get the task
    const [task] = await db
      .select()
      .from(aiTasks)
      .where(and(
        eq(aiTasks.id, taskId),
        eq(aiTasks.userId, userId)
      ));

    if (!task) {
      return NextResponse.json({ error: 'Task not found or access denied' }, { status: 404 });
    }

    // Update the task
    const updateData: {
      status: 'pending' | 'in_progress' | 'completed' | 'blocked';
      updatedAt: Date;
      completedAt: Date | null;
      metadata?: object;
    } = {
      status: status as 'pending' | 'in_progress' | 'completed' | 'blocked',
      updatedAt: new Date(),
      completedAt: status === 'completed' ? new Date() : null,
    };

    // Add note to metadata if provided
    if (note) {
      const notes = (task.metadata as { notes?: Array<{ content: string; timestamp: string }> })?.notes || [];
      notes.push({
        content: note,
        timestamp: new Date().toISOString(),
      });
      updateData.metadata = {
        ...(task.metadata || {}),
        notes,
        lastStatusChange: {
          from: task.status,
          to: status,
          at: new Date().toISOString(),
          note,
        },
      };
    } else {
      updateData.metadata = {
        ...(task.metadata || {}),
        lastStatusChange: {
          from: task.status,
          to: status,
          at: new Date().toISOString(),
        },
      };
    }

    const [updatedTask] = await db
      .update(aiTasks)
      .set(updateData)
      .where(eq(aiTasks.id, taskId))
      .returning();

    // Broadcast task update event
    await broadcastTaskEvent({
      type: 'task_updated',
      taskId: updatedTask.id,
      userId,
      data: {
        title: updatedTask.title,
        oldStatus: task.status,
        newStatus: status,
        note,
      },
    });

    // Check if parent list should be updated
    if (task.parentTaskId) {
      const siblingTasks = await db
        .select()
        .from(aiTasks)
        .where(and(
          eq(aiTasks.parentTaskId, task.parentTaskId),
          sql`${aiTasks.metadata}->>'type' = 'task_item'`
        ));

      const allCompleted = siblingTasks.every(t => 
        t.id === taskId ? status === 'completed' : t.status === 'completed'
      );

      if (allCompleted) {
        await db
          .update(aiTasks)
          .set({
            status: 'completed',
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(aiTasks.id, task.parentTaskId));
      } else if (status === 'in_progress') {
        // Update parent list to in_progress if it was pending
        await db
          .update(aiTasks)
          .set({
            status: 'in_progress',
            updatedAt: new Date(),
          })
          .where(and(
            eq(aiTasks.id, task.parentTaskId),
            eq(aiTasks.status, 'pending')
          ));
      }
    }

    return NextResponse.json({
      success: true,
      task: {
        id: updatedTask.id,
        title: updatedTask.title,
        status: updatedTask.status,
        updatedAt: updatedTask.updatedAt,
        completedAt: updatedTask.completedAt,
      }
    });

  } catch (error) {
    console.error('Error updating task status:', error);
    return NextResponse.json(
      { error: 'Failed to update task status' },
      { status: 500 }
    );
  }
}