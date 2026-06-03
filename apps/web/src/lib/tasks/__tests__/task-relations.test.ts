import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      taskItems: { findFirst: vi.fn() },
      pages: { findFirst: vi.fn() },
      taskLinks: { findFirst: vi.fn(), findMany: vi.fn() },
      taskDependencies: { findFirst: vi.fn() },
    },
    select: vi.fn(),
    insert: vi.fn(),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
  and: vi.fn((...c: unknown[]) => ({ and: c })),
  asc: vi.fn((c: unknown) => c),
  desc: vi.fn((c: unknown) => c),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: [a, b] })),
}));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id' } }));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { id: 'id' },
  taskLinks: { id: 'id', taskId: 'taskId', taskListPageId: 'taskListPageId', position: 'position' },
  taskDependencies: { id: 'id', blockerTaskId: 'blockerTaskId', blockedTaskId: 'blockedTaskId' },
}));
vi.mock('@/lib/websocket', () => ({ broadcastTaskEvent: vi.fn().mockResolvedValue(undefined) }));

import { addDependency, linkTask, getLinkedTasksForList, TaskRelationError } from '../task-relations';
import { db } from '@pagespace/db/db';

const allowEdit = async () => true;

/** Build a fetchTaskContext result row (taskItems.findFirst shape). */
function taskRow(opts: { id: string; parentId: string | null; driveId: string; isTrashed?: boolean }) {
  return {
    id: opts.id,
    pageId: `${opts.id}-page`,
    page: {
      id: `${opts.id}-page`,
      parentId: opts.parentId,
      driveId: opts.driveId,
      isTrashed: opts.isTrashed ?? false,
      title: opts.id,
    },
  };
}

describe('addDependency', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a task blocking itself', async () => {
    await expect(
      addDependency({ blockedTaskId: 't1', blockerTaskId: 't1', userId: 'u1', canEdit: allowEdit }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects cross-drive dependencies', async () => {
    vi.mocked(db.query.taskItems.findFirst)
      .mockResolvedValueOnce(taskRow({ id: 'blocked', parentId: 'listA', driveId: 'd1' }) as never)
      .mockResolvedValueOnce(taskRow({ id: 'blocker', parentId: 'listB', driveId: 'd2' }) as never);

    await expect(
      addDependency({ blockedTaskId: 'blocked', blockerTaskId: 'blocker', userId: 'u1', canEdit: allowEdit }),
    ).rejects.toThrow(/same drive/);
  });

  it('rejects a duplicate dependency', async () => {
    vi.mocked(db.query.taskItems.findFirst)
      .mockResolvedValueOnce(taskRow({ id: 'blocked', parentId: 'listA', driveId: 'd1' }) as never)
      .mockResolvedValueOnce(taskRow({ id: 'blocker', parentId: 'listA', driveId: 'd1' }) as never);
    vi.mocked(db.query.taskDependencies.findFirst).mockResolvedValue({ id: 'existing' } as never);

    await expect(
      addDependency({ blockedTaskId: 'blocked', blockerTaskId: 'blocker', userId: 'u1', canEdit: allowEdit }),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects an edge that would create a cycle', async () => {
    vi.mocked(db.query.taskItems.findFirst)
      .mockResolvedValueOnce(taskRow({ id: 'blocked', parentId: 'listA', driveId: 'd1' }) as never)
      .mockResolvedValueOnce(taskRow({ id: 'blocker', parentId: 'listA', driveId: 'd1' }) as never);
    vi.mocked(db.query.taskDependencies.findFirst).mockResolvedValue(undefined as never);
    // BFS from 'blocked' immediately reaches 'blocker' → cycle.
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ next: 'blocker' }]),
      }),
    } as never);

    await expect(
      addDependency({ blockedTaskId: 'blocked', blockerTaskId: 'blocker', userId: 'u1', canEdit: allowEdit }),
    ).rejects.toThrow(/cycle/);
  });

  it('rejects when the actor lacks edit permission', async () => {
    vi.mocked(db.query.taskItems.findFirst)
      .mockResolvedValueOnce(taskRow({ id: 'blocked', parentId: 'listA', driveId: 'd1' }) as never)
      .mockResolvedValueOnce(taskRow({ id: 'blocker', parentId: 'listA', driveId: 'd1' }) as never);

    await expect(
      addDependency({ blockedTaskId: 'blocked', blockerTaskId: 'blocker', userId: 'u1', canEdit: async () => false }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('linkTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects linking a task into its own home list', async () => {
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue(
      taskRow({ id: 'task1', parentId: 'listA', driveId: 'd1' }) as never,
    );
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(
      { id: 'listA', type: 'TASK_LIST', driveId: 'd1', isTrashed: false } as never,
    );

    await expect(
      linkTask({ taskId: 'task1', destTaskListPageId: 'listA', userId: 'u1', canEdit: allowEdit }),
    ).rejects.toThrow(/already lives/);
  });

  it('rejects cross-drive links', async () => {
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue(
      taskRow({ id: 'task1', parentId: 'listA', driveId: 'd1' }) as never,
    );
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(
      { id: 'listB', type: 'TASK_LIST', driveId: 'd2', isTrashed: false } as never,
    );

    await expect(
      linkTask({ taskId: 'task1', destTaskListPageId: 'listB', userId: 'u1', canEdit: allowEdit }),
    ).rejects.toThrow(/same drive/);
  });

  it('rejects linking into a non-TASK_LIST page', async () => {
    vi.mocked(db.query.taskItems.findFirst).mockResolvedValue(
      taskRow({ id: 'task1', parentId: 'listA', driveId: 'd1' }) as never,
    );
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(
      { id: 'doc1', type: 'DOCUMENT', driveId: 'd1', isTrashed: false } as never,
    );

    await expect(
      linkTask({ taskId: 'task1', destTaskListPageId: 'doc1', userId: 'u1', canEdit: allowEdit }),
    ).rejects.toThrow(/must be a TASK_LIST/);
  });
});

describe('getLinkedTasksForList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns enriched linked tasks and skips trashed ones, resolving home-list titles', async () => {
    vi.mocked(db.query.taskLinks.findMany).mockResolvedValue([
      {
        id: 'link1',
        position: 0,
        task: {
          id: 't1',
          pageId: 't1-page',
          status: 'pending',
          priority: 'medium',
          completedAt: null,
          dueDate: null,
          assigneeId: null,
          assigneeAgentId: null,
          page: { id: 't1-page', title: 'Task One', parentId: 'home-list', isTrashed: false },
          assignees: [],
        },
      },
      {
        id: 'link2',
        position: 1,
        task: {
          id: 't2',
          pageId: 't2-page',
          page: { id: 't2-page', title: 'Trashed', parentId: 'home-list', isTrashed: true },
          assignees: [],
        },
      },
    ] as never);
    // Home-list title lookup.
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: 'home-list', title: 'Home List' }]),
      }),
    } as never);

    const result = await getLinkedTasksForList('dest-list');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      linkId: 'link1',
      id: 't1',
      title: 'Task One',
      homeTaskListPageId: 'home-list',
      homeTaskListPageTitle: 'Home List',
    });
  });

  it('returns an empty array when the list has no links', async () => {
    vi.mocked(db.query.taskLinks.findMany).mockResolvedValue([] as never);
    const result = await getLinkedTasksForList('dest-list');
    expect(result).toEqual([]);
  });
});

describe('TaskRelationError', () => {
  it('carries an HTTP status', () => {
    const err = new TaskRelationError('nope', 409);
    expect(err.status).toBe(409);
    expect(err).toBeInstanceOf(Error);
  });
});
