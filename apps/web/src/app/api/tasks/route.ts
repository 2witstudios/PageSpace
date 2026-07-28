import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db'
import { eq, and, asc, desc, count, gt, gte, lt, lte, inArray, or, isNull, not, sql } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskItems, taskLists, taskStatusConfigs } from '@pagespace/db/schema/tasks';
import { DEFAULT_STATUS_CONFIG, type TaskStatusGroup } from '@/lib/task-status-config';
import { groupTaskListsByAllowedStatusSlugs } from './status-group-slugs';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { escapeLikePattern } from '@pagespace/lib/db/like-pattern';
import {
  authenticateRequestWithOptions,
  isAuthError,
  checkMCPDriveScope,
  isScopedMCPAuth,
  isPrincipalDriveMember,
  getPrincipalDriveIds,
  getPrincipalBatchPagePermissions,
} from '@/lib/auth';
import { decryptTaskUserRelations } from '@/lib/tasks/decrypt-task-relations';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: false };

// Page size for the cursor-paged task-list expansion. Keeps each query (and
// each scoped-token permission batch) bounded regardless of drive-universe size.
const TASK_LIST_PAGE_CHUNK = 500;

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
  includeCompleted: z.enum(['true', 'false']).transform(v => v === 'true').optional(),
  dueDateFilter: z.enum(['overdue', 'today', 'this_week', 'upcoming']).optional(),
  // Group-level status filter: 'active' = todo + in_progress, 'completed' = done.
  // Custom per-task-list status configs are honoured; fall back to DEFAULT_STATUS_CONFIG
  // when a task list has no entries.
  statusGroup: z.enum(['all', 'active', 'completed']).optional(),
  // Pagination
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

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
      includeCompleted: searchParams.get('includeCompleted') ?? undefined,
      dueDateFilter: searchParams.get('dueDateFilter') ?? undefined,
      statusGroup: searchParams.get('statusGroup') ?? undefined,
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

      // Verify the principal (user, or the token itself when drive-scoped) can view the drive
      const canViewDrive = await isPrincipalDriveMember(auth, params.driveId);
      if (!canViewDrive) {
        return NextResponse.json(
          { error: 'Unauthorized - you do not have access to this drive' },
          { status: 403 }
        );
      }

      const scopeError = checkMCPDriveScope(auth, params.driveId);
      if (scopeError) return scopeError;

      driveIds = [params.driveId];
    } else {
      // User context: the principal's drive universe (a scoped token's own memberships)
      driveIds = await getPrincipalDriveIds(auth);

      // Optional drive filter for user context
      if (params.driveId) {
        if (!driveIds.includes(params.driveId)) {
          return NextResponse.json(
            { error: 'Unauthorized - you do not have access to this drive' },
            { status: 403 }
          );
        }
        const driveIdScopeError = checkMCPDriveScope(auth, params.driveId);
        if (driveIdScopeError) return driveIdScopeError;
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

    // Expand the principal's task lists as bounded, cursor-paged, id-only
    // chunks — the old single unbounded findMany materialized every task list
    // in the drive universe (7,703 full rows for the 2026-07-28 OOM victim).
    // Enrichment data (titles, drive ids, status configs) is fetched later, for
    // only the task lists represented in the response page.
    let taskListPageIds: string[] = [];
    let taskListCursor: string | undefined;
    for (;;) {
      const chunk = await db.query.pages.findMany({
        where: and(
          eq(pages.type, 'TASK_LIST'),
          eq(pages.isTrashed, false),
          inArray(pages.driveId, driveIds),
          taskListCursor ? gt(pages.id, taskListCursor) : undefined,
        ),
        columns: { id: true },
        orderBy: [asc(pages.id)],
        limit: TASK_LIST_PAGE_CHUNK,
      });
      if (chunk.length === 0) break;
      taskListCursor = chunk[chunk.length - 1].id;
      taskListPageIds.push(...chunk.map(p => p.id));
      if (chunk.length < TASK_LIST_PAGE_CHUNK) break;
    }

    // Scoped tokens see only the task lists their own role grants view on —
    // custom roles can restrict visibility per page, not just per drive. One
    // batch call over all fetched ids: the helper enumerates the token's
    // accessible pages per allowed drive on every invocation, so filtering per
    // fetch-chunk would rescan the drive universe once per chunk.
    if (isScopedMCPAuth(auth) && taskListPageIds.length > 0) {
      const pagePerms = await getPrincipalBatchPagePermissions(auth, taskListPageIds);
      taskListPageIds = taskListPageIds.filter(id => pagePerms.get(id)?.canView);
    }

    if (taskListPageIds.length === 0) {
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

    // Subquery: task pages that are non-trashed TASK_LIST children of accessible list pages
    const validTaskPageSubquery = db
      .select({ id: pages.id })
      .from(pages)
      .where(and(
        inArray(pages.parentId, taskListPageIds),
        eq(pages.type, 'TASK_LIST'),
        eq(pages.isTrashed, false),
      ));

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
      inArray(taskItems.pageId, validTaskPageSubquery),
      assigneeCondition,
    ].filter(Boolean);

    if (params.status) {
      filterConditions.push(eq(taskItems.status, params.status));
    } else if (!params.includeCompleted && !params.statusGroup) {
      // Exclude completed tasks by default, matching the internal get_assigned_tasks
      // tool. Skipped when the caller already scopes completion via statusGroup
      // (which may itself request 'completed') or explicitly opts in.
      filterConditions.push(isNull(taskItems.completedAt));
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
    // Search filter (case-insensitive title/description). Title lives on pages,
    // so match it via a subquery against pages.title.
    if (params.search) {
      const escapedSearch = escapeLikePattern(params.search);
      const searchPattern = `%${escapedSearch}%`;
      const titleMatchSubquery = db
        .select({ id: pages.id })
        .from(pages)
        .where(sql`${pages.title} ILIKE ${searchPattern} ESCAPE '\\'`);
      filterConditions.push(
        inArray(taskItems.pageId, titleMatchSubquery)
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

    // Group-level status filter. Convert the requested group into DISTINCT
    // allowed-slug sets (custom configs first, defaults if none) and build an OR
    // of one (pageId IN plain-id-array, status IN slugs) condition per set —
    // typically ~2 conditions. One condition per task list, each carrying its own
    // correlated subquery, is what OOM-killed Postgres on 2026-07-28 for a
    // principal with 7,703 task lists.
    if (params.statusGroup && params.statusGroup !== 'all') {
      // Custom configs only — lists without rows fall back to defaults in the
      // grouping helper, so this stays proportional to customized lists.
      const customConfigRows = await db
        .select({
          listPageId: taskLists.pageId,
          slug: taskStatusConfigs.slug,
          group: taskStatusConfigs.group,
        })
        .from(taskStatusConfigs)
        .innerJoin(taskLists, eq(taskStatusConfigs.taskListId, taskLists.id))
        .where(inArray(taskLists.pageId, taskListPageIds));
      const configsByListPageId = new Map<string, { slug: string; group: TaskStatusGroup }[]>();
      for (const { listPageId, ...config } of customConfigRows) {
        if (!listPageId) continue;
        const existing = configsByListPageId.get(listPageId);
        if (existing) existing.push(config);
        else configsByListPageId.set(listPageId, [config]);
      }

      const slugGroups = groupTaskListsByAllowedStatusSlugs(
        taskListPageIds,
        configsByListPageId,
        params.statusGroup,
      );

      if (slugGroups.length === 0) {
        return NextResponse.json({
          tasks: [],
          statusConfigsByTaskList: {},
          pagination: {
            total: 0,
            limit: params.limit,
            offset: params.offset,
            hasMore: false,
          },
        });
      }

      // One membership subquery per DISTINCT slug set (typically ~2) keeps the
      // child-task-page relation in SQL. Same membership as the old per-list
      // subqueries: parentId in the group's lists, type TASK_LIST, not trashed.
      // Materializing child ids app-side would scale bind parameters with the
      // number of TASKS (not lists) and can exceed Postgres's 65,535-parameter
      // cap; per-LIST subqueries (the old shape) put thousands of subplans in
      // one statement. Per-set subqueries avoid both.
      const perSlugSetConditions = slugGroups.map(group => and(
        inArray(taskItems.pageId, db
          .select({ id: pages.id })
          .from(pages)
          .where(and(
            inArray(pages.parentId, group.listPageIds),
            eq(pages.type, 'TASK_LIST'),
            eq(pages.isTrashed, false),
          ))),
        inArray(taskItems.status, group.slugs),
      ));

      filterConditions.push(or(...perSlugSetConditions));
    }

    const whereCondition = and(...filterConditions);

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
          columns: { id: true, title: true, isTrashed: true, parentId: true, position: true },
        },
      },
      orderBy: [desc(taskItems.updatedAt)],
      limit: params.limit,
      offset: params.offset,
    });

    const decryptedTasks = await decryptTaskUserRelations(tasks);

    // Enrichment data (list page info + status configs) covers only the task
    // lists represented in this page of results, keyed by the task list PAGE ID.
    const representedListPageIds = [...new Set(
      decryptedTasks
        .map(task => task.page?.parentId)
        .filter((id): id is string => !!id)
    )];

    const representedListPages = representedListPageIds.length > 0
      ? await db
          .select({ id: pages.id, driveId: pages.driveId, title: pages.title })
          .from(pages)
          .where(inArray(pages.id, representedListPageIds))
      : [];
    const taskListPageMap = new Map(representedListPages.map(p => [p.id, p]));

    const representedConfigRows = representedListPageIds.length > 0
      ? await db
          .select({
            listPageId: taskLists.pageId,
            id: taskStatusConfigs.id,
            taskListId: taskStatusConfigs.taskListId,
            name: taskStatusConfigs.name,
            slug: taskStatusConfigs.slug,
            color: taskStatusConfigs.color,
            group: taskStatusConfigs.group,
            position: taskStatusConfigs.position,
          })
          .from(taskStatusConfigs)
          .innerJoin(taskLists, eq(taskStatusConfigs.taskListId, taskLists.id))
          .where(inArray(taskLists.pageId, representedListPageIds))
      : [];

    const taskListStatusMap = new Map<string, Array<{
      id: string; taskListId: string; name: string;
      slug: string; color: string; group: TaskStatusGroup; position: number;
    }>>();
    for (const { listPageId, ...config } of representedConfigRows) {
      if (!listPageId) continue;
      const existing = taskListStatusMap.get(listPageId);
      if (existing) existing.push(config);
      else taskListStatusMap.set(listPageId, [config]);
    }
    const serializedStatusConfigsByTaskList = Object.fromEntries(taskListStatusMap);

    // Enrich tasks with drive, task list page info, and status metadata
    // Filter out orphaned tasks where parent list is not accessible
    const enrichedTasks = decryptedTasks
      .map(task => {
        const listPageId = task.page?.parentId;
        const pageInfo = listPageId ? taskListPageMap.get(listPageId) : undefined;
        if (!listPageId || !pageInfo) {
          loggers.api.warn('Task has no accessible parent task list - skipping', {
            taskId: task.id,
            listPageId,
          });
          return null;
        }

        const configs = taskListStatusMap.get(listPageId) || [];
        const matchingConfig = configs.find(c => c.slug === task.status);
        const defaultConfig = DEFAULT_STATUS_CONFIG[task.status];

        const statusGroup = matchingConfig?.group || defaultConfig?.group || 'todo';
        const statusLabel = matchingConfig?.name || defaultConfig?.label || task.status;
        const statusColor = matchingConfig?.color || defaultConfig?.color || 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400';

        return {
          ...task,
          // Sourced from the linked page — the single ordering rail (#2143).
          position: task.page?.position ?? 0,
          title: task.page?.title ?? '',
          driveId: pageInfo.driveId,
          taskListPageId: listPageId,
          taskListPageTitle: pageInfo.title,
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

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'tasks', resourceId: userId, details: { context: params.context } });

    return NextResponse.json({
      tasks: enrichedTasks,
      statusConfigsByTaskList: serializedStatusConfigsByTaskList,
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
