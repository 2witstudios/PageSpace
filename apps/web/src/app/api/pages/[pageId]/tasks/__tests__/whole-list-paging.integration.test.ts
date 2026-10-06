/**
 * Whole-list paging of GET /tasks, proven against a real Postgres.
 *
 * Clients that need every task of a list (apps/imago's fetchTaskList, which
 * feeds its Tree, Focus and Board views) page with plain `limit`/`offset`:
 * `?limit=200&offset=0`, then `offset=<tasks so far>` while `hasMore`. The
 * route later gained opt-in `statusGroup` (Active / Completed tabs) and
 * `perStatus` (kanban columns) paging. This pins that the plain mode stays a
 * single window over every status — done tasks included, in position order —
 * and shows why a whole-list client must not opt into either new mode.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable.
 */
import { describe, it, beforeAll, vi } from 'vitest';
import { assert } from '@/hooks/__tests__/riteway';
import { db } from '@pagespace/db/db';
import { pages } from '@pagespace/db/schema/core';
import { taskItems, taskLists } from '@pagespace/db/schema/tasks';
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
vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn(),
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(() => ({})),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

/** The route's largest page (query-spec.ts MAX_LIMIT), which imago asks for. */
const PAGE_SIZE = 200;
/** Done tasks first: the shape where a status-filtered window would crowd them out. */
const DONE_COUNT = 120;
const ACTIVE_STATUSES = ['pending', 'in_progress', 'blocked'] as const;
const ACTIVE_COUNT = 90;

type TasksBody = { tasks: { id: string; status: string }[]; hasMore: boolean };

let dbAvailable = false;
let listTasksRoute: typeof import('../route');

/** A list of DONE_COUNT completed tasks followed by ACTIVE_COUNT open ones, ids in position order. */
async function seedLongList() {
  const owner = await factories.createUser();
  currentUserId = owner.id;
  const drive = await factories.createDrive(owner.id);
  const listPage = await factories.createPage(drive.id, { type: 'TASK_LIST' });
  await db.insert(taskLists).values({ userId: owner.id, pageId: listPage.id, title: 'Long list', status: 'pending' });

  const ids: string[] = [];
  for (let i = 0; i < DONE_COUNT + ACTIVE_COUNT; i++) {
    const page = await factories.createPage(drive.id, {
      parentId: listPage.id, type: 'TASK_LIST', title: `Task ${i}`, position: i + 1,
    });
    const status = i < DONE_COUNT ? 'completed' : ACTIVE_STATUSES[i % ACTIVE_STATUSES.length];
    const [item] = await db.insert(taskItems)
      .values({ userId: owner.id, pageId: page.id, status })
      .returning({ id: taskItems.id });
    ids.push(item.id);
  }
  return { listPage, ids };
}

const getTasks = async (pageId: string, query: string): Promise<TasksBody> => {
  const response = await listTasksRoute.GET(
    new Request(`http://localhost/api/pages/${pageId}/tasks?${query}`),
    { params: Promise.resolve({ pageId }) },
  );
  return response.json();
};

/** apps/imago's fetchTaskList, request for request. */
const loadWholeList = async (pageId: string) => {
  const first = await getTasks(pageId, `limit=${PAGE_SIZE}&offset=0`);
  const bodies = [first];
  let tasks = first.tasks;
  let hasMore = first.hasMore;
  while (hasMore) {
    const next = await getTasks(pageId, `limit=${PAGE_SIZE}&offset=${tasks.length}`);
    bodies.push(next);
    tasks = [...tasks, ...next.tasks];
    hasMore = next.hasMore;
  }
  return { tasks, bodies };
};

// The route's first import is a cold module graph (see status-inheritance's
// WARM_UP_TIMEOUT_MS); seeding 210 tasks one row at a time rides on it too.
const WARM_UP_TIMEOUT_MS = 60_000;
const SEED_TIMEOUT_MS = 60_000;

describe('GET /tasks whole-list paging', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('whole-list-paging.integration.test.ts', error);
      dbAvailable = false;
      return;
    }
    listTasksRoute = await import('../route');
  }, WARM_UP_TIMEOUT_MS);

  it('returns every task of a long list, done ones included, in position order', async () => {
    if (!dbAvailable) return;
    const { listPage, ids } = await seedLongList();
    const { tasks, bodies } = await loadWholeList(listPage.id);

    assert({
      given: 'a 210-task list paged with plain limit/offset as imago does',
      should: 'answer a full first page with hasMore, then the rest without it',
      actual: bodies.map((body) => [body.tasks.length, body.hasMore]),
      expected: [[PAGE_SIZE, true], [DONE_COUNT + ACTIVE_COUNT - PAGE_SIZE, false]],
    });

    assert({
      given: 'the pages joined in request order',
      should: 'hold every task exactly once, in position order',
      actual: tasks.map((task) => task.id),
      expected: ids,
    });

    assert({
      given: 'a list whose first 120 tasks are done',
      should: 'keep the done tasks alongside the open ones',
      actual: tasks.filter((task) => task.status === 'completed').length,
      expected: DONE_COUNT,
    });
  }, SEED_TIMEOUT_MS);

  it('narrows the window only when a client opts into statusGroup or perStatus', async () => {
    if (!dbAvailable) return;
    const { listPage } = await seedLongList();

    const active = await getTasks(listPage.id, `limit=${PAGE_SIZE}&offset=0&statusGroup=active`);
    assert({
      given: 'statusGroup=active on the same list',
      should: 'leave the done tasks out, so a whole-list client must not send it',
      actual: [active.tasks.length, active.tasks.some((task) => task.status === 'completed')],
      expected: [ACTIVE_COUNT, false],
    });

    const columnsPastFirstPage = await getTasks(listPage.id, `limit=${PAGE_SIZE}&offset=${PAGE_SIZE}&perStatus=true`);
    assert({
      given: 'perStatus=true with the offset a whole-list client would send next',
      should: 'count the offset within each column and return nothing, so a whole-list client must not send it',
      actual: [columnsPastFirstPage.tasks.length, columnsPastFirstPage.hasMore],
      expected: [0, false],
    });
  }, SEED_TIMEOUT_MS);
});
