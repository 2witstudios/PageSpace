import { NextResponse } from 'next/server';
import { db, pages, taskMetadata, users, driveMembers, drives, pagePermissions, and, eq, or, gte, lte, inArray, desc, sql } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };

/**
 * GET /api/tasks
 * Query tasks with filters - respects page-level permissions
 *
 * Permission model:
 * - Drive owners see all tasks in their drive
 * - Drive admins see all tasks in their drive
 * - Regular members only see tasks with explicit page_permissions (canView=true)
 *
 * Query parameters:
 * - driveId: Filter by drive ID
 * - assigneeId: Filter by assignee ID
 * - status: Filter by status (pending, in_progress, completed, blocked, cancelled)
 * - priority: Filter by priority (low, medium, high, urgent)
 * - dueBefore: Filter tasks due before this date (ISO string)
 * - dueAfter: Filter tasks due after this date (ISO string)
 * - limit: Limit number of results (default: 50)
 * - offset: Offset for pagination (default: 0)
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
    const { searchParams } = new URL(request.url);
    const driveId = searchParams.get('driveId');
    const assigneeId = searchParams.get('assigneeId');
    const status = searchParams.get('status');
    const priority = searchParams.get('priority');
    const dueBefore = searchParams.get('dueBefore');
    const dueAfter = searchParams.get('dueAfter');
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    // Get all drives the user is a member of
    const userMemberships = await db.query.driveMembers.findMany({
      where: eq(driveMembers.userId, userId),
    });

    if (userMemberships.length === 0) {
      return NextResponse.json({ tasks: [], total: 0 });
    }

    // If driveId is specified, verify user has access
    if (driveId) {
      const hasAccess = userMemberships.some(m => m.driveId === driveId);
      if (!hasAccess) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
    }

    // Build base conditions
    const conditions: any[] = [
      eq(pages.type, 'TASK'),
      eq(pages.isTrashed, false),
    ];

    // Filter by drive(s)
    if (driveId) {
      conditions.push(eq(pages.driveId, driveId));
    } else {
      const driveIds = userMemberships.map(m => m.driveId);
      conditions.push(inArray(pages.driveId, driveIds));
    }

    // Filter by task metadata
    if (assigneeId) {
      conditions.push(eq(taskMetadata.assigneeId, assigneeId));
    }

    if (status) {
      conditions.push(eq(taskMetadata.status, status as any));
    }

    if (priority) {
      conditions.push(eq(taskMetadata.priority, priority as any));
    }

    if (dueBefore) {
      conditions.push(lte(taskMetadata.dueDate, new Date(dueBefore)));
    }

    if (dueAfter) {
      conditions.push(gte(taskMetadata.dueDate, new Date(dueAfter)));
    }

    // Build permission condition using OR:
    // User can see a task if:
    // 1. They are the drive owner, OR
    // 2. They are a drive admin, OR
    // 3. They have explicit page permission with canView=true
    const permissionCondition = or(
      eq(drives.ownerId, userId), // User is drive owner
      and(
        eq(driveMembers.userId, userId),
        eq(driveMembers.role, 'ADMIN')
      ), // User is drive admin
      and(
        eq(pagePermissions.userId, userId),
        eq(pagePermissions.canView, true)
      ) // User has explicit page permission
    );

    conditions.push(permissionCondition);

    // Query tasks with metadata and user information
    const tasks = await db
      .select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        content: pages.content,
        driveId: pages.driveId,
        parentId: pages.parentId,
        createdAt: pages.createdAt,
        updatedAt: pages.updatedAt,
        // Task metadata
        taskMetadataId: taskMetadata.id,
        assigneeId: taskMetadata.assigneeId,
        assignerId: taskMetadata.assignerId,
        status: taskMetadata.status,
        priority: taskMetadata.priority,
        dueDate: taskMetadata.dueDate,
        startDate: taskMetadata.startDate,
        completedAt: taskMetadata.completedAt,
        estimatedHours: taskMetadata.estimatedHours,
        actualHours: taskMetadata.actualHours,
        labels: taskMetadata.labels,
        customFields: taskMetadata.customFields,
        taskCreatedAt: taskMetadata.createdAt,
        taskUpdatedAt: taskMetadata.updatedAt,
        // Assignee info
        assigneeName: users.name,
        assigneeEmail: users.email,
        assigneeImage: users.image,
      })
      .from(pages)
      .innerJoin(taskMetadata, eq(pages.id, taskMetadata.pageId))
      .innerJoin(drives, eq(pages.driveId, drives.id))
      .leftJoin(driveMembers, and(
        eq(driveMembers.driveId, pages.driveId),
        eq(driveMembers.userId, userId)
      ))
      .leftJoin(pagePermissions, and(
        eq(pagePermissions.pageId, pages.id),
        eq(pagePermissions.userId, userId)
      ))
      .leftJoin(users, eq(taskMetadata.assigneeId, users.id))
      .where(and(...conditions))
      .orderBy(desc(taskMetadata.priority), desc(pages.updatedAt))
      .limit(limit)
      .offset(offset);

    // Get total count with same permission filtering
    const [countResult] = await db
      .select({ count: sql<number>`count(distinct ${pages.id})` })
      .from(pages)
      .innerJoin(taskMetadata, eq(pages.id, taskMetadata.pageId))
      .innerJoin(drives, eq(pages.driveId, drives.id))
      .leftJoin(driveMembers, and(
        eq(driveMembers.driveId, pages.driveId),
        eq(driveMembers.userId, userId)
      ))
      .leftJoin(pagePermissions, and(
        eq(pagePermissions.pageId, pages.id),
        eq(pagePermissions.userId, userId)
      ))
      .where(and(...conditions));

    return NextResponse.json({
      tasks,
      total: Number(countResult?.count || 0),
      limit,
      offset,
    });
  } catch (error) {
    loggers.api.error('Error querying tasks:', error as Error);
    return NextResponse.json({ error: 'Failed to query tasks' }, { status: 500 });
  }
}
