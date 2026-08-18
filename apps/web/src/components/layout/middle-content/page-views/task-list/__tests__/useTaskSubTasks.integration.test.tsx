/**
 * The gate, proven against a real Postgres.
 *
 * `GET /api/pages/[pageId]/tasks` is not a read. `getOrCreateTaskListForPage`
 * (route.ts:33) lazily INSERTs a `task_lists` row plus 4 `task_status_configs`
 * rows for any pageId it has not seen before. Expanding 50 leaf tasks in the task
 * list would therefore create 50 task lists and 200 status-config rows.
 *
 * A test that mocks fetch and asserts "no request was made" cannot prove this:
 * the write is server-side, so the only evidence that counts is the absence of
 * the rows. This suite drives the REAL hook, wires its fetch to the REAL route
 * handler, and then asks the database what happened.
 *
 * The parent-task case is deliberately in the same file: it proves the route
 * really does write on GET, so the leaf case is a guarantee about a live hazard
 * rather than an assertion about something that was never going to happen.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable — a
 * silent skip would be a green, zero-assertion pass. Local runs without Docker
 * opt out explicitly with ALLOW_SKIP_DB_TESTS=1.
 */
import React from 'react';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { taskItems, taskLists, taskStatusConfigs } from '@pagespace/db/schema/tasks';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { useTaskSubTasks } from '../useTaskSubTasks';

// The hook's only outbound edge. Pointing it at the route handler (rather than at a
// canned response) is what makes the database assertions below meaningful.
const { fetchWithAuth } = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth }));

// The route's auth/permission edge is not what this suite is testing; the DB is.
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

let currentUserId = '';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const makeWrapper = () => {
  const cache = new Map();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <SWRConfig value={{ provider: () => cache, dedupingInterval: 0 }}>{children}</SWRConfig>;
  };
};

/** Every task_lists / task_status_configs row the route could have lazily created for a page. */
async function lazyRowsFor(pageId: string) {
  const lists = await db.select({ id: taskLists.id })
    .from(taskLists).where(eq(taskLists.pageId, pageId)).limit(10);
  if (lists.length === 0) return { taskLists: 0, statusConfigs: 0 };
  const configs = await db.select({ id: taskStatusConfigs.id })
    .from(taskStatusConfigs)
    .where(inArray(taskStatusConfigs.taskListId, lists.map((l) => l.id)))
    .limit(100);
  return { taskLists: lists.length, statusConfigs: configs.length };
}

let dbAvailable = false;

describe('useTaskSubTasks against the real route and database', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('useTaskSubTasks.integration.test.tsx', error);
      dbAvailable = false;
    }

    if (!dbAvailable) return;

    // The real handler, addressed exactly as the hook addresses it.
    const { GET } = await import('@/app/api/pages/[pageId]/tasks/route');
    fetchWithAuth.mockImplementation(async (url: string) => {
      const full = new URL(url, 'http://localhost');
      const pageId = full.pathname.split('/')[3];
      return GET(new Request(full.toString()), { params: Promise.resolve({ pageId }) });
    });
  });

  it('creates no task_lists or task_status_configs rows for a leaf task', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    currentUserId = owner.id;
    const drive = await factories.createDrive(owner.id);
    const listPage = await factories.createPage(drive.id, { type: 'TASK_LIST' });
    // A task IS a TASK_LIST page — that is the mechanism behind infinite nesting.
    const leafPage = await factories.createPage(drive.id, { parentId: listPage.id, type: 'TASK_LIST' });
    await db.insert(taskItems).values({ userId: owner.id, pageId: leafPage.id });

    const before = await lazyRowsFor(leafPage.id);

    const { result } = renderHook(
      () => useTaskSubTasks({ pageId: leafPage.id, subTaskCount: 0 }),
      { wrapper: makeWrapper() },
    );
    // Let any errant fetch effect fire and its response land before asserting absence.
    await new Promise((r) => setTimeout(r, 50));

    const after = await lazyRowsFor(leafPage.id);

    assert({
      given: 'a leaf task expanded in the UI',
      should: 'leave the database exactly as it found it — no lazily created task list, no status configs',
      actual: { before, after, requests: fetchWithAuth.mock.calls.length, subTasks: result.current.subTasks.length },
      expected: {
        before: { taskLists: 0, statusConfigs: 0 },
        after: { taskLists: 0, statusConfigs: 0 },
        requests: 0,
        subTasks: 0,
      },
    });
  });

  it('resolves sub-tasks for a parent task from the existing route', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    currentUserId = owner.id;
    const drive = await factories.createDrive(owner.id);
    const listPage = await factories.createPage(drive.id, { type: 'TASK_LIST' });
    const parentPage = await factories.createPage(drive.id, { parentId: listPage.id, type: 'TASK_LIST' });
    await db.insert(taskItems).values({ userId: owner.id, pageId: parentPage.id });

    const childA = await factories.createPage(drive.id, { parentId: parentPage.id, type: 'TASK_LIST', title: 'Child A' });
    const childB = await factories.createPage(drive.id, { parentId: parentPage.id, type: 'TASK_LIST', title: 'Child B' });
    await db.insert(taskItems).values([
      { userId: owner.id, pageId: childA.id, status: 'pending' },
      { userId: owner.id, pageId: childB.id, status: 'pending' },
    ]);
    // pages.position is the single ordering rail the route sorts on (#2143).
    await db.update(pages).set({ position: 1 }).where(eq(pages.id, childA.id));
    await db.update(pages).set({ position: 2 }).where(eq(pages.id, childB.id));

    const { result } = renderHook(
      () => useTaskSubTasks({ pageId: parentPage.id, subTaskCount: 2 }),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.subTasks).toHaveLength(2));

    assert({
      given: 'a task with two sub-task pages beneath it',
      should: 'resolve them from GET /api/pages/{task.pageId}/tasks — no new endpoint',
      actual: result.current.subTasks.map((t) => t.title),
      expected: ['Child A', 'Child B'],
    });

    // The same response carries the sub-task list's own status configs — the 4 defaults the
    // route just lazily created for this task's list. A renderer one level down needs them to
    // label a status at all, and only a real route can show they actually arrive.
    assert({
      given: "the sub-task list's freshly created status configs",
      should: 'arrive with the sub-tasks, as the default four slugs',
      actual: result.current.statusConfigs.map((c) => c.slug).sort(),
      expected: ['blocked', 'completed', 'in_progress', 'pending'],
    });

    // The other half of the proof: the route really does write on GET, so the leaf
    // case above is a guarantee about a hazard that exists.
    assert({
      given: 'the same GET the leaf task was spared',
      should: 'have lazily created one task_lists row and its 4 default status configs',
      actual: await lazyRowsFor(parentPage.id),
      expected: { taskLists: 1, statusConfigs: 4 },
    });
  });

  it('does not re-issue the GET — and so cannot re-run its writes — on re-expand', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    currentUserId = owner.id;
    const drive = await factories.createDrive(owner.id);
    const listPage = await factories.createPage(drive.id, { type: 'TASK_LIST' });
    const parentPage = await factories.createPage(drive.id, { parentId: listPage.id, type: 'TASK_LIST' });
    await db.insert(taskItems).values({ userId: owner.id, pageId: parentPage.id });
    const child = await factories.createPage(drive.id, { parentId: parentPage.id, type: 'TASK_LIST', title: 'Only child' });
    await db.insert(taskItems).values({ userId: owner.id, pageId: child.id });

    const wrapper = makeWrapper();
    const callsBefore = fetchWithAuth.mock.calls.length;

    const first = renderHook(
      () => useTaskSubTasks({ pageId: parentPage.id, subTaskCount: 1 }),
      { wrapper },
    );
    await waitFor(() => expect(first.result.current.subTasks).toHaveLength(1));
    const callsAfterFirstExpand = fetchWithAuth.mock.calls.length - callsBefore;

    first.unmount(); // collapse

    const second = renderHook(
      () => useTaskSubTasks({ pageId: parentPage.id, subTaskCount: 1 }),
      { wrapper },
    );
    await waitFor(() => expect(second.result.current.subTasks).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));

    assert({
      given: 'a task expanded, collapsed, and expanded again',
      should: 'serve the second expansion from cache — one GET total',
      actual: {
        firstExpand: callsAfterFirstExpand,
        total: fetchWithAuth.mock.calls.length - callsBefore,
      },
      expected: { firstExpand: 1, total: 1 },
    });
  });

  it('leaves no lazily created task lists behind after expanding a page of leaf tasks', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    currentUserId = owner.id;
    const drive = await factories.createDrive(owner.id);
    const listPage = await factories.createPage(drive.id, { type: 'TASK_LIST' });

    const leafPageIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const leaf = await factories.createPage(drive.id, { parentId: listPage.id, type: 'TASK_LIST', title: `Leaf ${i}` });
      await db.insert(taskItems).values({ userId: owner.id, pageId: leaf.id });
      leafPageIds.push(leaf.id);
    }

    const wrapper = makeWrapper();
    for (const pageId of leafPageIds) {
      renderHook(() => useTaskSubTasks({ pageId, subTaskCount: 0 }), { wrapper });
    }
    await new Promise((r) => setTimeout(r, 50));

    const created = await db
      .select({ id: taskLists.id })
      .from(taskLists)
      .where(inArray(taskLists.pageId, leafPageIds))
      .limit(50);
    const strayConfigs = created.length === 0 ? [] : await db
      .select({ id: taskStatusConfigs.id })
      .from(taskStatusConfigs)
      .where(inArray(taskStatusConfigs.taskListId, created.map((c) => c.id)))
      .limit(200);

    assert({
      given: '10 leaf tasks all expanded at once — the 50-tasks-200-rows scenario in miniature',
      should: 'create zero task lists and zero status configs',
      actual: { taskLists: created.length, statusConfigs: strayConfigs.length },
      expected: { taskLists: 0, statusConfigs: 0 },
    });
  });

  it('backs the sub-task count the row already showed', async () => {
    if (!dbAvailable) return;

    const owner = await factories.createUser();
    currentUserId = owner.id;
    const drive = await factories.createDrive(owner.id);
    const listPage = await factories.createPage(drive.id, { type: 'TASK_LIST' });
    const parentPage = await factories.createPage(drive.id, { parentId: listPage.id, type: 'TASK_LIST' });
    await db.insert(taskItems).values({ userId: owner.id, pageId: parentPage.id });
    const child = await factories.createPage(drive.id, { parentId: parentPage.id, type: 'TASK_LIST', title: 'Grandchild holder' });
    await db.insert(taskItems).values({ userId: owner.id, pageId: child.id });
    const grandchild = await factories.createPage(drive.id, { parentId: child.id, type: 'TASK_LIST', title: 'Grandchild' });
    await db.insert(taskItems).values({ userId: owner.id, pageId: grandchild.id });

    const { result } = renderHook(
      () => useTaskSubTasks({ pageId: parentPage.id, subTaskCount: 1 }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.subTasks).toHaveLength(1));

    assert({
      given: 'a sub-task that itself has a sub-task',
      should: 'carry its own subTaskCount, so the next level can apply the same gate without another request',
      actual: result.current.subTasks[0].subTaskCount,
      expected: 1,
    });
  });
});
