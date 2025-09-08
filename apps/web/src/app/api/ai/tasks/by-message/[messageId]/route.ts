import { NextRequest, NextResponse } from 'next/server';
import { db, aiTasks, eq, and, asc } from '@pagespace/db';
import { decodeToken } from '@pagespace/lib/auth-utils';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ messageId: string }> }
) {
  try {
    const { messageId } = await context.params;

    // Get user from token
    const authHeader = request.headers.get('authorization');
    const cookieHeader = request.headers.get('cookie');
    
    let token: string | null = null;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (cookieHeader) {
      const accessTokenMatch = cookieHeader.match(/accessToken=([^;]+)/);
      if (accessTokenMatch) {
        token = accessTokenMatch[1];
      }
    }

    if (!token) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const payload = await decodeToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    // Get all tasks for this message
    const tasks = await db
      .select()
      .from(aiTasks)
      .where(and(
        eq(aiTasks.messageId, messageId),
        eq(aiTasks.userId, payload.userId)
      ))
      .orderBy(asc(aiTasks.position));

    // Find the main task list (parent task)
    const taskList = tasks.find(task => (task.metadata as { type?: string })?.type === 'task_list');
    
    // Get individual task items
    const taskItems = tasks.filter(task => (task.metadata as { type?: string })?.type === 'task_item');

    if (!taskList) {
      return NextResponse.json({ 
        error: 'Task list not found for this message' 
      }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      taskList: {
        id: taskList.id,
        title: taskList.title,
        description: taskList.description,
        status: taskList.status,
        createdAt: taskList.createdAt,
        updatedAt: taskList.updatedAt,
      },
      tasks: taskItems.map(task => ({
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        position: task.position,
        completedAt: task.completedAt,
        metadata: task.metadata,
      }))
    });

  } catch (error) {
    console.error('Error loading tasks by message:', error);
    return NextResponse.json(
      { error: 'Failed to load tasks' },
      { status: 500 }
    );
  }
}