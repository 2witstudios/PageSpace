import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db, taskItems, taskLists, taskStatusConfigs, pages, eq, and, desc, count, gte, lt, lte, inArray, or, isNull, not, sql } from '@pagespace/db';
import { DEFAULT_STATUS_CONFIG } from '@/components/layout/middle-content/page-views/task-list/task-list-types';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isUserDriveMember, getDriveIdsForUser } from '@pagespace/lib';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: false };

// Query parameter schema
const querySchema = z.object({
  context: z.enum(['user', 'drive']),
  driveId: z.string().optional(),
  // Filter parameters - status accepts any string for custom statuses
  status: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  // New filter parameters
  search: z.string().optional(),
  assigneeId: z.string().optional(),
  assigneeAgentId: z.string().optional(),
  showAllAssignees: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  dueDateFilter: z.enum(['overdue', 'today', 'this_week', 'upcoming']).optional(),
  // Pagination
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/**
 * Escape SQL LIKE pattern special characters to prevent wildcard injection.
 * Must be used with ESCAPE '\\' clause in the query.
 */
function escapeLikePattern(value: string): string {
  return value
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/%/g, '\\%')    // Escape percent
    .replace(/_/g, '\\_');   // Escape underscore
}

/**
 * GET /api/tasks
 *
 * Fetch tasks assigned to the current user based on context:
 * - user: All tasks assigned to user across all accessible drives
 * - drive: All tasks assigned to user within a specific drive
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;
  const { searchParams } = new URL(request.url);

  try {
    // Parse and validate query parameters
    const parseResult = querySchema.safeParse({
      context: searchParams.get('context') || 'user',
      driveId: searchParams.get('driveId') ?? undefined,
      status: searchParams.get('status') ?? undefined,
      priority: searchParams.get('priority') ?? undefined,
      startDate: searchParams.get('startDate') ?? undefined,
      endDate: searchParams.get('endDate') ?? undefined,
      search: searchParams.get('search') ?? undefined,
      assigneeId: searchParams.get('assigneeId') ?? undefined,
      assigneeAgentId: searchParams.get('assigneeAgentId') ?? undefined,
      showAllAssignees: searchParams.get('showAllAssignees') ?? undefined,
      dueDateFilter: searchParams.get('dueDateFilter') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
      offset: searchParams.get('offset') ?? undefined,
    });

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues.map(i => i.message).join('. ') },
        { status: 400 }
      );
    }

    const params = parseResult.data;

    // Get the list of driveIds to query
    let driveIds: string[] = [];

    if (params.context === 'drive') {
      if (!params.driveId) {
        return NextResponse.json(
          { error: 'driveId is required for drive context' },
          { status: 400 }
        );
      }

      // Verify user can view drive
      const canViewDrive = await isUserDriveMember(userId, params.driveId);
      if (!canViewDrive) {
        return NextResponse.json(
          { error: 'Unauthorized - you do not have access to this drive' },
          { status: 403 }
        );
      }

      driveIds = [params.driveId];
    } else {
      // User context: get all accessible drive IDs
      driveIds = await getDriveIdsForUser(userId);

      // Optional drive filter for user context
      if (params.driveId) {
        if (!driveIds.includes(params.driveId)) {
          return NextResponse.json(
            { error: 'Unauthorized - you do not have access to this drive' },
            { status: 403 }
          );
        }
        driveIds = [params.driveId];
      }
    }

    if (driveIds.length === 0) {
      return NextResponse.json({
        tasks: [],
        pagination: {
          total: 0,
          limit: params.limit,
          offset: params.offset,
          hasMore: false,
        },
      });
    }

    // First, get all task list pages in the accessible drives
    const taskListPages = await db.query.pages.findMany({
      where: and(
        eq(pages.type, 'TASK_LIST'),
        eq(pages.isTrashed, false),
        inArray(pages.driveId, driveIds)
      ),
      columns: { id: true, driveId: true, title: true },
    });

    if (taskListPages.length === 0) {
      return NextResponse.json({
        tasks: [],
        pagination: {
          total: 0,
          limit: params.limit,
          offset: params.offset,
          hasMore: false,
        },
      });
    }

    const taskListPageIds = taskListPages.map(p => p.id);

    // Get task lists linked to these pages
    const taskListsData = await db.query.taskLists.findMany({
      where: inArray(taskLists.pageId, taskListPageIds),
      columns: { id: true, pageId: true },
    });

    if (taskListsData.length === 0) {
      return NextResponse.json({
        tasks: [],
        pagination: {
          total: 0,
          limit: params.limit,
          offset: params.offset,
          hasMore: false,
        },
      });
    }

    const taskListIds = taskListsData.map(tl => tl.id);

    // Build map of taskListId -> page info for enriching results
    const taskListToPageMap = new Map<string, { pageId: string; driveId: string; taskListTitle: string }>();
    for (const tl of taskListsData) {
      const pageInfo = taskListPages.find(p => p.id === tl.pageId);
      if (pageInfo) {
        taskListToPageMap.set(tl.id, {
          pageId: pageInfo.id,
          driveId: pageInfo.driveId,
          taskListTitle: pageInfo.title,
        });
      }
    }

    // Get trashed page IDs to exclude tasks referencing them
    // This ensures pagination counts match the actual filtered results
    const trashedPages = await db.select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.isTrashed, true), inArray(pages.driveId, driveIds)));
    const trashedPageIds = trashedPages.map(p => p.id);

    // Build assignee filter condition
    // Default: tasks assigned to current user
    // If assigneeId or assigneeAgentId is provided, filter by that instead
    // If showAllAssignees is true, don't filter by assignee at all
    let assigneeCondition;
    if (params.showAllAssignees) {
      // No assignee filter - show all tasks in accessible drives
      assigneeCondition = undefined;
    } else if (params.assigneeAgentId) {
      assigneeCondition = eq(taskItems.assigneeAgentId, params.assigneeAgentId);
    } else if (params.assigneeId) {
      assigneeCondition = eq(taskItems.assigneeId, params.assigneeId);
    } else {
      assigneeCondition = eq(taskItems.assigneeId, userId);
    }

    // Build filter conditions for tasks
    const filterConditions = [
      inArray(taskItems.taskListId, taskListIds),
      assigneeCondition,
      // Exclude tasks whose linked page is trashed (pageId is null OR not in trashed list)
      trashedPageIds.length > 0
        ? or(isNull(taskItems.pageId), not(inArray(taskItems.pageId, trashedPageIds)))
        : undefined,
    ].filter(Boolean);

    if (params.status) {
      filterConditions.push(eq(taskItems.status, params.status));
    }
    if (params.priority) {
      filterConditions.push(eq(taskItems.priority, params.priority));
    }
    if (params.startDate) {
      filterConditions.push(gte(taskItems.createdAt, params.startDate));
    }
    if (params.endDate) {
      const endOfDay = new Date(params.endDate);
      endOfDay.setDate(endOfDay.getDate() + 1);
      filterConditions.push(lt(taskItems.createdAt, endOfDay));
    }
    // Search filter (case-insensitive title/description)
    if (params.search) {
      const escapedSearch = escapeLikePattern(params.search);
      const searchPattern = `%${escapedSearch}%`;
      filterConditions.push(
        or(
          sql`${taskItems.title} ILIKE ${searchPattern} ESCAPE '\\'`,
          sql`${taskItems.description} ILIKE ${searchPattern} ESCAPE '\\'`
        )
      );
    }
    // Due date filter
    if (params.dueDateFilter) {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const endOfWeek = new Date(today);
      endOfWeek.setDate(endOfWeek.getDate() + (7 - today.getDay())); // End of current week (Sunday)

      switch (params.dueDateFilter) {
        case 'overdue':
          filterConditions.push(
            and(
              not(isNull(taskItems.dueDate)),
              lt(taskItems.dueDate, today),
              isNull(taskItems.completedAt)
            )
          );
          break;
        case 'today':
          filterConditions.push(
            and(
              gte(taskItems.dueDate, today),
              lt(taskItems.dueDate, tomorrow)
            )
          );
          break;
        case 'this_week':
          filterConditions.push(
            and(
              gte(taskItems.dueDate, today),
              lte(taskItems.dueDate, endOfWeek)
            )
          );
          break;
        case 'upcoming':
          filterConditions.push(
            and(
              not(isNull(taskItems.dueDate)),
              gte(taskItems.dueDate, today)
            )
          );
          break;
      }
    }

    const whereCondition = and(...filterConditions);

    // Fetch status configs for all involved task lists
    const statusConfigRows = await db.query.taskStatusConfigs.findMany({
      where: inArray(taskStatusConfigs.taskListId, taskListIds),
    });

    // Build map: taskListId -> status configs
    const taskListStatusMap = new Map<string, typeof statusConfigRows>();
    for (const config of statusConfigRows) {
      const existing = taskListStatusMap.get(config.taskListId) || [];
      existing.push(config);
      taskListStatusMap.set(config.taskListId, existing);
    }

    // Fetch tasks with relations (including multi-assignees)
    const tasks = await db.query.taskItems.findMany({
      where: whereCondition,
      with: {
        assignee: {
          columns: { id: true, name: true, image: true },
        },
        assigneeAgent: {
          columns: { id: true, title: true, type: true },
        },
        assignees: {
          with: {
            user: { columns: { id: true, name: true, image: true } },
            agentPage: { columns: { id: true, title: true, type: true } },
          },
        },
        user: {
          columns: { id: true, name: true, image: true },
        },
        page: {
          columns: { id: true, title: true, isTrashed: true },
        },
        taskList: {
          columns: { id: true, pageId: true, title: true },
        },
      },
      orderBy: [desc(taskItems.updatedAt)],
      limit: params.limit,
      offset: params.offset,
    });

    // Enrich tasks with drive, task list page info, and status metadata
    // Filter out orphaned tasks where pageInfo is missing to prevent undefined URLs
    const enrichedTasks = tasks
      .map(task => {
        const pageInfo = taskListToPageMap.get(task.taskListId);
        if (!pageInfo) {
          loggers.api.warn('Task has orphaned taskListId - skipping', {
            taskId: task.id,
            taskListId: task.taskListId,
          });
          return null;
        }

        // Compute status metadata from custom configs or defaults
        const configs = taskListStatusMap.get(task.taskListId) || [];
        const matchingConfig = configs.find(c => c.slug === task.status);
        const defaultConfig = DEFAULT_STATUS_CONFIG[task.status];

        const statusGroup = matchingConfig?.group || defaultConfig?.group || 'todo';
        const statusLabel = matchingConfig?.name || defaultConfig?.label || task.status;
        const statusColor = matchingConfig?.color || defaultConfig?.color || 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400';

        return {
          ...task,
          driveId: pageInfo.driveId,
          taskListPageId: pageInfo.pageId,
          taskListPageTitle: pageInfo.taskListTitle,
          statusGroup,
          statusLabel,
          statusColor,
        };
      })
      .filter((task): task is NonNullable<typeof task> => task !== null);

    // Get total count for pagination
    const [countResult] = await db
      .select({ total: count() })
      .from(taskItems)
      .where(whereCondition);

    const total = countResult?.total ?? 0;

    return NextResponse.json({
      tasks: enrichedTasks,
      pagination: {
        total,
        limit: params.limit,
        offset: params.offset,
        hasMore: params.offset + enrichedTasks.length < total,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching tasks:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch tasks' },
      { status: 500 }
    );
  }
}
