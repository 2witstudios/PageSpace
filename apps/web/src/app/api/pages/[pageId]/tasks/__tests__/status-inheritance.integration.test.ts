/**
 * Status vocabulary inheritance, proven against a real Postgres.
 *
 * The hazard this closes: status configs are per-task-list, and PATCH validates
 * a submitted slug against the configs of the list named in its URL
 * (`tasks/[taskId]/route.ts`). A sub-list used to be born with the four
 * DEFAULT_TASK_STATUSES regardless of what its parent's vocabulary was — so on
 * any list whose owner renamed or added statuses, rendering the root's statuses
 * on a nested row produced a slug the sub-list did not define, and the write
 * came back `400 Invalid status`.
 *
 * The fix is inheritance at SEED time, not a UI convention: a new sub-list is
 * created with its nearest ancestor task list's vocabulary. That leaves every
 * existing validation rule untouched — which is the point, since
 * normalizeStatusForList exists specifically to guarantee "a task's status is
 * always a slug its own list defines".
 *
 * Only a real database can show this. The evidence is the rows the lazy-init
 * path actually wrote, and then a PATCH with an inherited slug coming back 200.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable.
 */
import { describe, it, beforeAll, vi } from 'vitest';
import { assert } from '@/hooks/__tests__/riteway';
import { db } from '@pagespace/db/db';
import { eq, asc } from '@pagespace/db/operators';
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
vi.mock('@/lib/websocket', () => ({
  broadcastTaskEvent: vi.fn(),
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn(() => ({})),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

/** The custom vocabulary a root list's owner might define. */
const CUSTOM_STATUSES = [
  { slug: 'icebox', name: 'Icebox', color: 'bg-slate-100', group: 'todo' as const, position: 0 },
  { slug: 'building', name: 'Building', color: 'bg-amber-100', group: 'in_progress' as const, position: 1 },
  { slug: 'shipped', name: 'Shipped', color: 'bg-green-100', group: 'done' as const, position: 2 },
];

let dbAvailable = false;
let listTasksRoute: typeof import('../route');
let taskItemRoute: typeof import('../[taskId]/route');

async function slugsFor(pageId: string): Promise<string[]> {
  const list = await db.query.taskLists.findFirst({ where: eq(taskLists.pageId, pageId) });
  if (!list) return [];
  const configs = await db
    .select({ slug: taskStatusConfigs.slug })
    .from(taskStatusConfigs)
    .where(eq(taskStatusConfigs.taskListId, list.id))
    .orderBy(asc(taskStatusConfigs.position))
    .limit(50);
  return configs.map((c) => c.slug);
}

/**
 * Build a root list with a CUSTOM vocabulary and one task under it, then drive
 * the GET route against that task's own page — the exact call an expanded row
 * makes, and the one that lazily creates the sub-list.
 */
async function seedCustomisedTree() {
  const owner = await factories.createUser();
  currentUserId = owner.id;
  const drive = await factories.createDrive(owner.id);
  const listPage = await factories.createPage(drive.id, { type: 'TASK_LIST' });

  const [rootList] = await db.insert(taskLists).values({
    userId: owner.id, pageId: listPage.id, title: 'Root', status: 'pending',
  }).returning();
  await db.insert(taskStatusConfigs).values(
    CUSTOM_STATUSES.map((s) => ({ taskListId: rootList.id, ...s })),
  );

  const taskPage = await factories.createPage(drive.id, {
    parentId: listPage.id, type: 'TASK_LIST', title: 'Parent task',
  });
  const [task] = await db.insert(taskItems)
    .values({ userId: owner.id, pageId: taskPage.id, status: 'icebox' })
    .returning();

  return { owner, drive, listPage, taskPage, task };
}

const getTasks = (pageId: string) =>
  listTasksRoute.GET(
    new Request(`http://localhost/api/pages/${pageId}/tasks`),
    { params: Promise.resolve({ pageId }) },
  );

describe('sub-list status vocabulary inheritance', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('status-inheritance.integration.test.ts', error);
      dbAvailable = false;
      return;
    }
    listTasksRoute = await import('../route');
    taskItemRoute = await import('../[taskId]/route');
  });

  it('seeds a new sub-list with its ancestor vocabulary, not the defaults', async () => {
    if (!dbAvailable) return;
    const { taskPage } = await seedCustomisedTree();

    assert({
      given: 'no sub-list yet for a task under a list with customised statuses',
      should: 'have nothing seeded before the first read',
      actual: await slugsFor(taskPage.id),
      expected: [],
    });

    // The lazy-init path: expanding this task calls the list route with the
    // TASK's own pageId, which creates its sub-list.
    await getTasks(taskPage.id);

    assert({
      given: 'a sub-list created under a list with customised statuses',
      should: "inherit the ancestor's slugs rather than the four defaults",
      actual: await slugsFor(taskPage.id),
      expected: ['icebox', 'building', 'shipped'],
    });
  });

  it('accepts an inherited slug on PATCH — the 400 this exists to prevent', async () => {
    if (!dbAvailable) return;
    const { owner, drive, taskPage } = await seedCustomisedTree();

    // A sub-task under that task. Reading the parent creates the sub-list.
    const subPage = await factories.createPage(drive.id, {
      parentId: taskPage.id, type: 'TASK_LIST', title: 'Sub-task',
    });
    const [subTask] = await db.insert(taskItems)
      .values({ userId: owner.id, pageId: subPage.id, status: 'icebox' })
      .returning();
    await getTasks(taskPage.id);

    // Exactly what a nested status dropdown showing the ROOT vocabulary submits.
    const res = await taskItemRoute.PATCH(
      new Request(`http://localhost/api/pages/${taskPage.id}/tasks/${subTask.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'shipped' }),
      }),
      { params: Promise.resolve({ pageId: taskPage.id, taskId: subTask.id }) },
    );
    const body = await res.json();

    assert({
      given: 'a nested row submitting a status inherited from the root list',
      should: 'be accepted, and be recorded as complete because the slug is a done-group one',
      actual: { status: res.status, taskStatus: body?.status, completed: !!body?.completedAt },
      expected: { status: 200, taskStatus: 'shipped', completed: true },
    });
  });

  it('creates a sub-task with a status its own inherited list defines', async () => {
    if (!dbAvailable) return;
    const { taskPage } = await seedCustomisedTree();

    // Exactly what the inline "+ Add a sub-task" row sends: a title and nothing
    // else. Before the default was resolved from the list, this wrote the
    // hardcoded 'pending' — a slug an inherited vocabulary does not define, so
    // the row came back unclassifiable by isCompletedStatus and rendered by the
    // status dropdown's raw-slug fallback with no matching option.
    const res = await listTasksRoute.POST(
      new Request(`http://localhost/api/pages/${taskPage.id}/tasks`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Added inline' }),
      }),
      { params: Promise.resolve({ pageId: taskPage.id }) },
    );
    const created = await res.json();

    assert({
      given: 'a sub-task created with no explicit status, under an inherited vocabulary',
      should: 'take the first status that vocabulary actually defines',
      actual: { status: res.status, taskStatus: created?.status },
      expected: { status: 201, taskStatus: 'icebox' },
    });

    assert({
      given: 'that same sub-task',
      should: 'carry a slug the list defines, so it is renderable and classifiable',
      actual: (await slugsFor(taskPage.id)).includes(created?.status),
      expected: true,
    });
  });

  it('seeds a committed, inherited vocabulary even under concurrent lazy init', async () => {
    // Only a real database shows what this guards. A raised 23505 aborts the
    // whole transaction, so a seeder that CATCHES it lets the callback return
    // normally while Postgres converts the COMMIT to a ROLLBACK — and the
    // caller is handed a task_lists row that was never committed, whose
    // (nonexistent) configs then send resolveSeedStatus back to the 'pending'
    // fallback. ON CONFLICT DO NOTHING never raises, so nothing aborts.
    //
    // NOTE, deliberately not asserted: `task_lists.pageId` carries only an
    // index, not a unique constraint (unlike `task_items.pageId`), and
    // getOrCreateTaskListForPage is a check-then-insert. Two simultaneous
    // callers therefore create two rows. That race predates this branch and
    // fixing it needs a migration; what matters here is that whatever commits
    // is complete and correctly seeded, never a phantom.
    //
    // A consequence worth stating plainly: because the two callers seed two
    // DIFFERENT list ids, their config inserts do not actually collide, so this
    // test is an end-state assertion and NOT a regression guard for the ON
    // CONFLICT clause — reverting to a catch would very likely leave it green.
    // The next test, where both repairs target one existing list, is the one
    // that collides and the one that goes red.
    if (!dbAvailable) return;
    const { taskPage } = await seedCustomisedTree();

    const [a, b] = await Promise.all([getTasks(taskPage.id), getTasks(taskPage.id)]);

    const lists = await db.select({ id: taskLists.id })
      .from(taskLists).where(eq(taskLists.pageId, taskPage.id)).limit(10);
    const perList = await Promise.all(lists.map(async (l) => {
      const configs = await db
        .select({ slug: taskStatusConfigs.slug })
        .from(taskStatusConfigs)
        .where(eq(taskStatusConfigs.taskListId, l.id))
        .orderBy(asc(taskStatusConfigs.position))
        .limit(50);
      return configs.map((c) => c.slug);
    }));

    assert({
      given: 'two concurrent lazy-init reads of the same task page',
      should: 'both succeed, and every list that committed carries the inherited vocabulary',
      actual: {
        statuses: [a.status, b.status],
        committed: lists.length > 0,
        everyListInherited: perList.every(
          (slugs) => JSON.stringify(slugs) === JSON.stringify(['icebox', 'building', 'shipped']),
        ),
      },
      expected: { statuses: [200, 200], committed: true, everyListInherited: true },
    });
  });

  it('repairs a config-less list under concurrency without raising', async () => {
    // The one path where two callers can seed the SAME task_lists id: a list
    // row that exists but has no configs (legacy, or a half-finished init).
    // Both take the repair branch, both insert the same (taskListId, slug)
    // pairs, and one loses the race. ON CONFLICT DO NOTHING absorbs that; a
    // catch would have to correctly identify a DrizzleQueryError first.
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    currentUserId = owner.id;
    const drive = await factories.createDrive(owner.id);
    const listPage = await factories.createPage(drive.id, { type: 'TASK_LIST' });
    const [rootList] = await db.insert(taskLists).values({
      userId: owner.id, pageId: listPage.id, title: 'Root', status: 'pending',
    }).returning();
    await db.insert(taskStatusConfigs).values(
      CUSTOM_STATUSES.map((c) => ({ taskListId: rootList.id, ...c })),
    );

    // A child task whose own list exists but was never given configs.
    const taskPage = await factories.createPage(drive.id, {
      parentId: listPage.id, type: 'TASK_LIST',
    });
    await db.insert(taskItems).values({ userId: owner.id, pageId: taskPage.id, status: 'icebox' });
    await db.insert(taskLists).values({
      userId: owner.id, pageId: taskPage.id, title: 'Sub', status: 'pending',
    });

    const [a, b] = await Promise.all([getTasks(taskPage.id), getTasks(taskPage.id)]);

    assert({
      given: 'two concurrent repairs of the same config-less list',
      should: 'both succeed and seed the inherited vocabulary exactly once',
      actual: {
        statuses: [a.status, b.status],
        slugs: await slugsFor(taskPage.id),
      },
      expected: {
        statuses: [200, 200],
        slugs: ['icebox', 'building', 'shipped'],
      },
    });
  });

  it('still seeds the defaults for a list with no task-list ancestor', async () => {
    if (!dbAvailable) return;
    const owner = await factories.createUser();
    currentUserId = owner.id;
    const drive = await factories.createDrive(owner.id);
    // A root list sits under the drive or a folder — it is nobody's sub-list, so
    // there is nothing to inherit and the defaults are correct.
    const folder = await factories.createPage(drive.id, { type: 'FOLDER' });
    const listPage = await factories.createPage(drive.id, {
      parentId: folder.id, type: 'TASK_LIST',
    });

    await getTasks(listPage.id);

    assert({
      given: 'a task list whose parent is a folder',
      should: 'seed the four built-in statuses',
      actual: await slugsFor(listPage.id),
      expected: ['pending', 'in_progress', 'blocked', 'completed'],
    });
  });

  it('stops at a non-task ancestor instead of reaching past it', async () => {
    // The case the folder-at-the-root test cannot reach: there IS a customised
    // task list above, but a FOLDER sits between. Inheriting through it would
    // hand a list its grandparent's vocabulary across a boundary the user drew
    // deliberately — a folder is where one project's conventions stop.
    //
    // The other test terminates on a missing parentId and never evaluates the
    // type check at all, so removing that check left it green.
    if (!dbAvailable) return;
    const { drive, listPage } = await seedCustomisedTree();
    const folder = await factories.createPage(drive.id, {
      parentId: listPage.id, type: 'FOLDER',
    });
    const nested = await factories.createPage(drive.id, {
      parentId: folder.id, type: 'TASK_LIST',
    });

    await getTasks(nested.id);

    assert({
      given: 'a customised task list separated from this one by a folder',
      should: 'seed the built-in statuses rather than reach past the folder',
      actual: await slugsFor(nested.id),
      expected: ['pending', 'in_progress', 'blocked', 'completed'],
    });
  });

  it('brings a legacy list\'s existing tasks into the vocabulary it just inherited', async () => {
    // The price of inheriting on the REPAIR path. Seeding DEFAULT_TASK_STATUSES
    // always defined 'pending' — the schema default for task_items.status, and
    // so exactly what a legacy row carries. Seeding the ancestor's vocabulary
    // instead would leave those rows holding a slug their own list does not
    // define, which PATCH rejects with a 400 and which nothing else repairs:
    // backfillMissingTaskItems only visits pages with no row at all.
    if (!dbAvailable) return;
    const { owner, drive, taskPage } = await seedCustomisedTree();
    // A sub-list that exists but was never given configs, holding a task left
    // on the built-in default.
    await db.insert(taskLists).values({
      userId: owner.id, pageId: taskPage.id, title: 'Sub', status: 'pending',
    });
    const legacyChild = await factories.createPage(drive.id, {
      parentId: taskPage.id, type: 'TASK_LIST',
    });
    await db.insert(taskItems).values({
      userId: owner.id, pageId: legacyChild.id, status: 'pending',
    });

    await getTasks(taskPage.id);

    const [row] = await db.select({ status: taskItems.status })
      .from(taskItems).where(eq(taskItems.pageId, legacyChild.id)).limit(1);
    assert({
      given: "a pre-existing task on a slug the inherited vocabulary does not define",
      should: "move it to that vocabulary's open status",
      actual: { status: row?.status, slugs: await slugsFor(taskPage.id) },
      expected: { status: 'icebox', slugs: ['icebox', 'building', 'shipped'] },
    });
  });

  it('inherits through more than one level', async () => {
    if (!dbAvailable) return;
    const { owner, drive, taskPage } = await seedCustomisedTree();

    // Grandchild: its parent task has no task_lists row of its own yet, so the
    // walk has to keep going up rather than stop at the first ancestor it sees.
    const childPage = await factories.createPage(drive.id, {
      parentId: taskPage.id, type: 'TASK_LIST', title: 'Child',
    });
    await db.insert(taskItems).values({ userId: owner.id, pageId: childPage.id, status: 'icebox' });

    await getTasks(childPage.id);

    assert({
      given: 'a task two levels below the customised root, with no list in between',
      should: 'still inherit the root vocabulary',
      actual: await slugsFor(childPage.id),
      expected: ['icebox', 'building', 'shipped'],
    });
  });
});
