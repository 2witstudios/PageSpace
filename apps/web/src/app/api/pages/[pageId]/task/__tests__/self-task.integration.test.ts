/**
 * The page's own task row, proven against a real Postgres.
 *
 * Two things need a database to show:
 *
 *  - This route must NOT lazily write. Its sibling `/tasks` runs
 *    getOrCreateTaskListForPage, which inserts a task_lists row plus status
 *    configs for any page it has not seen. A header that mounts on every task
 *    screen must not do that to the parent list, and the only evidence that
 *    counts is the absence of the rows.
 *  - The status vocabulary it returns has to be the PARENT list's, because that
 *    is what the PATCH this header issues will be validated against.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable.
 */
import { describe, it, beforeAll, vi } from 'vitest';
import { assert } from '@/hooks/__tests__/riteway';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { taskItems, taskLists, taskStatusConfigs } from '@pagespace/db/schema/tasks';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';

let currentUserId = '';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(async () => ({ userId: currentUserId })),
  isAuthError: vi.fn(() => false),
  checkMCPPageScope: vi.fn(async () => null),
  canPrincipalViewPage: vi.fn(async () => true),
  canPrincipalEditPage: vi.fn(async () => true),
}));

let dbAvailable = false;
let route: typeof import('../route');

const CUSTOM = [
  { slug: 'icebox', name: 'Icebox', color: 'x', group: 'todo' as const, position: 0 },
  { slug: 'shipped', name: 'Shipped', color: 'x', group: 'done' as const, position: 1 },
];

const get = async (pageId: string) => {
  const res = await route.GET(
    new Request(`http://localhost/api/pages/${pageId}/task`),
    { params: Promise.resolve({ pageId }) },
  );
  return res.json();
};

async function lazyRowsFor(pageId: string) {
  const lists = await db.select({ id: taskLists.id })
    .from(taskLists).where(eq(taskLists.pageId, pageId)).limit(10);
  if (lists.length === 0) return { taskLists: 0, statusConfigs: 0 };
  const configs = await db.select({ id: taskStatusConfigs.id })
    .from(taskStatusConfigs)
    .where(eq(taskStatusConfigs.taskListId, lists[0].id))
    .limit(100);
  return { taskLists: lists.length, statusConfigs: configs.length };
}

describe('GET /api/pages/[pageId]/task', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('self-task.integration.test.ts', error);
      dbAvailable = false;
      return;
    }
    route = await import('../route');
  });

  it('returns the page\'s own task with the PARENT list\'s vocabulary', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    currentUserId = owner.id;
    const drive = await factories.createDrive(owner.id);
    const listPage = await factories.createPage(drive.id, { type: 'TASK_LIST' });
    const [rootList] = await db.insert(taskLists).values({
      userId: owner.id, pageId: listPage.id, title: 'Root', status: 'pending',
    }).returning();
    await db.insert(taskStatusConfigs).values(CUSTOM.map(s => ({ taskListId: rootList.id, ...s })));

    const taskPage = await factories.createPage(drive.id, {
      parentId: listPage.id, type: 'TASK_LIST', title: 'The task',
    });
    await db.insert(taskItems).values({ userId: owner.id, pageId: taskPage.id, status: 'icebox' });

    const body = await get(taskPage.id);
    assert({
      given: 'a page that is a task under a customised list',
      should: "return its task, its parent list page, and the PARENT's slugs",
      actual: {
        status: body.task?.status,
        listPageId: body.listPageId,
        slugs: body.statusConfigs.map((c: { slug: string }) => c.slug),
      },
      expected: { status: 'icebox', listPageId: listPage.id, slugs: ['icebox', 'shipped'] },
    });
  });

  it('creates no task_lists or status_configs rows for the parent', async () => {
    // The whole reason this is not a read of the parent's /tasks route.
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    currentUserId = owner.id;
    const drive = await factories.createDrive(owner.id);
    // Parent list has NO task_lists row yet — exactly the case where /tasks
    // would lazily create one plus four status configs.
    const listPage = await factories.createPage(drive.id, { type: 'TASK_LIST' });
    const taskPage = await factories.createPage(drive.id, {
      parentId: listPage.id, type: 'TASK_LIST',
    });
    await db.insert(taskItems).values({ userId: owner.id, pageId: taskPage.id });

    const before = await lazyRowsFor(listPage.id);
    const body = await get(taskPage.id);
    const after = await lazyRowsFor(listPage.id);

    assert({
      given: 'a header mounting on a task whose parent list was never initialized',
      should: 'leave the database exactly as it found it, and report an empty vocabulary',
      actual: { before, after, slugs: body.statusConfigs.length },
      expected: {
        before: { taskLists: 0, statusConfigs: 0 },
        after: { taskLists: 0, statusConfigs: 0 },
        slugs: 0,
      },
    });
  });

  it('reports the page\'s own sub-task counts so the header can honour the guard', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    currentUserId = owner.id;
    const drive = await factories.createDrive(owner.id);
    const listPage = await factories.createPage(drive.id, { type: 'TASK_LIST' });
    const taskPage = await factories.createPage(drive.id, {
      parentId: listPage.id, type: 'TASK_LIST',
    });
    await db.insert(taskItems).values({ userId: owner.id, pageId: taskPage.id });

    const a = await factories.createPage(drive.id, { parentId: taskPage.id, type: 'TASK_LIST' });
    const b = await factories.createPage(drive.id, { parentId: taskPage.id, type: 'TASK_LIST' });
    await db.insert(taskItems).values([
      { userId: owner.id, pageId: a.id, completedAt: new Date() },
      { userId: owner.id, pageId: b.id },
    ]);

    const body = await get(taskPage.id);
    assert({
      given: 'a task with one of two sub-tasks complete',
      should: 'report both counts',
      actual: [body.task?.subTaskCount, body.task?.subTaskCompletedCount],
      expected: [2, 1],
    });
  });

  it('returns no task for a list that is not itself a task', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    currentUserId = owner.id;
    const drive = await factories.createDrive(owner.id);
    const folder = await factories.createPage(drive.id, { type: 'FOLDER' });
    const listPage = await factories.createPage(drive.id, {
      parentId: folder.id, type: 'TASK_LIST',
    });

    const body = await get(listPage.id);
    assert({
      given: 'a top-level task list under a folder',
      should: 'report no self task, so the header renders nothing',
      actual: body.task,
      expected: null,
    });
  });
});
