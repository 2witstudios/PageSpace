/**
 * The three things this epic set out to fix, driven through the real app.
 *
 *  1. Clicking a checkbox is instant and does not refetch the list.
 *  2. Sub-tasks are interactive rows — a nested checkbox completes in place
 *     instead of navigating away.
 *  3. The task you are looking at can be completed from its own screen.
 */
import type { Page, APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures/auth.fixture';

async function csrf(request: APIRequestContext): Promise<string> {
  const res = await request.get('/api/auth/csrf');
  return ((await res.json()) as { csrfToken: string }).csrfToken;
}

async function createList(request: APIRequestContext, driveId: string, title: string) {
  const token = await csrf(request);
  const res = await request.post('/api/pages', {
    headers: { 'X-CSRF-Token': token },
    data: { title, type: 'TASK_LIST', driveId, parentId: null },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function createTask(request: APIRequestContext, listPageId: string, title: string) {
  const token = await csrf(request);
  const res = await request.post(`/api/pages/${listPageId}/tasks`, {
    headers: { 'X-CSRF-Token': token },
    data: { title },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { id: string; pageId: string };
}

const wideViewport = async (page: Page) => page.setViewportSize({ width: 1600, height: 1000 });

/**
 * The desktop table and the narrow card list both render every task, so a bare
 * text locator matches the hidden card first. The row checkboxes carry an
 * aria-label only in the table, which makes them the unambiguous handle.
 */
const rowCheckbox = (page: Page, title: string) =>
  page.getByRole('checkbox', { name: new RegExp(`(Complete|Reopen) ${title}$`, 'i') });

/**
 * The list defaults to the "Active" filter, so a task vanishes the moment it is
 * completed. Switch to "All" first, or every assertion after a completion is
 * really asserting on the filter.
 */
const showAllTasks = async (page: Page) => {
  await page.getByRole('button', { name: 'All', exact: true }).click();
};

test('completing a top-level task is immediate and refetches nothing', async ({ page, request, driveId }) => {
  const listPageId = await createList(request, driveId, `Tree A ${Date.now()}`);
  await createTask(request, listPageId, 'Alpha');

  await wideViewport(page);
  await page.goto(`/dashboard/${driveId}/${listPageId}`);
  await expect(rowCheckbox(page, 'Alpha')).toBeVisible();
  await showAllTasks(page);

  // Count list GETs from the click onwards. Before the fix, one click cost two
  // full revalidations of every loaded page.
  let listGets = 0;
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().includes(`/api/pages/${listPageId}/tasks?`)) listGets++;
  });

  // Hold the PATCH open. Asserting "checked" after an unhindered click only
  // proves the tick arrives quickly — it could equally be arriving from the
  // server response. Blocking the response makes "optimistic" the only
  // explanation for a checked box.
  let releasePatch: () => void = () => {};
  const patchHeld = new Promise<void>((r) => { releasePatch = r; });
  let patchSeen = false;
  await page.route(`**/api/pages/${listPageId}/tasks/*`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    patchSeen = true;
    await patchHeld;
    await route.fallback();
  });

  const checkbox = rowCheckbox(page, 'Alpha');
  await checkbox.click();

  // Checked while the write is still in flight — this is the whole fix.
  await expect(checkbox).toBeChecked();
  expect(patchSeen, 'the PATCH should be in flight, not yet answered').toBe(true);
  expect(listGets, 'no refetch may be issued while the write is pending').toBe(0);

  // Release, then wait for the response itself rather than a fixed delay.
  const settled = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes(`/tasks/`),
  );
  releasePatch();
  await settled;

  // Reconciliation and any deferred revalidation both run off that response;
  // give the microtask queue a turn and assert the count did not move.
  await expect.poll(() => listGets, {
    message: 'a completion should trigger no list refetch',
    timeout: 2000,
  }).toBe(0);
  await expect(checkbox).toBeChecked();
});

test('a sub-task completes in place instead of navigating away', async ({ page, request, driveId }) => {
  const listPageId = await createList(request, driveId, `Tree B ${Date.now()}`);
  const parent = await createTask(request, listPageId, 'Parent');
  await createTask(request, parent.pageId, 'Child');

  await wideViewport(page);
  await page.goto(`/dashboard/${driveId}/${listPageId}`);
  await expect(rowCheckbox(page, 'Parent')).toBeVisible();
  await showAllTasks(page);

  // The parent shows its sub-task progress before anything is expanded.
  await expect(page.locator('table').getByTitle('0/1 sub-tasks complete')).toBeVisible();

  // The tree is announced as a tree. Only the real app renders the depth-0 row
  // wrapper (TaskListView's SortableTaskRow), so this is the one place the
  // top-level row's own aria state can actually be checked.
  await expect(page.getByRole('treegrid', { name: 'Tasks' })).toBeVisible();
  const parentRow = () => page.locator('tr[data-task-id]').filter({ hasText: 'Parent' }).first();
  await expect(parentRow()).toHaveAttribute('aria-expanded', 'false');
  await expect(parentRow()).toHaveAttribute('aria-level', '1');

  await page.getByRole('button', { name: /Expand Parent/i }).click();
  await expect(rowCheckbox(page, 'Child')).toBeVisible();

  await expect(parentRow(), 'the top-level row must announce that it opened')
    .toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByText('Child').locator('xpath=ancestor::tr[1]'),
    'a nested row is announced one level deeper',
  ).toHaveAttribute('aria-level', '2');

  const urlBefore = page.url();
  const childBox = rowCheckbox(page, 'Child');
  await childBox.click();

  await expect(childBox).toBeChecked({ timeout: 2000 });
  expect(page.url(), 'completing a sub-task must not navigate').toBe(urlBefore);

  // The parent's progress follows its child.
  await expect(page.locator('table').getByTitle('1/1 sub-tasks complete')).toBeVisible();

  // And the parent, previously blocked, can now be completed.
  const parentBox = rowCheckbox(page, 'Parent');
  await parentBox.click();
  await expect(parentBox).toBeChecked({ timeout: 2000 });
});

test('a task can be completed from its own screen', async ({ page, request, driveId }) => {
  const listPageId = await createList(request, driveId, `Tree C ${Date.now()}`);
  const parent = await createTask(request, listPageId, 'Container');

  await wideViewport(page);
  await page.goto(`/dashboard/${driveId}/${parent.pageId}`);

  const selfBox = page.getByRole('checkbox', { name: /Complete this task/i });
  await expect(selfBox).toBeVisible();
  await expect(page.getByLabel('Status of this task')).toBeVisible();

  await selfBox.click();
  await expect(page.getByRole('checkbox', { name: /Reopen this task/i })).toBeVisible({ timeout: 3000 });

  // The parent list agrees.
  await page.goto(`/dashboard/${driveId}/${listPageId}`);
  await showAllTasks(page);
  await expect(rowCheckbox(page, 'Container')).toBeChecked();
});

test('completing a sub-task unblocks the header without a refresh', async ({ page, request, driveId }) => {
  // The workflow the header exists for: open a task, clear the work under it,
  // finish it. The guard reads sub-task counts, so if they only refreshed on
  // window focus the header would keep refusing while the row below shows done.
  const listPageId = await createList(request, driveId, `Tree E ${Date.now()}`);
  const parent = await createTask(request, listPageId, 'Container');
  await createTask(request, parent.pageId, 'Blocker');

  await wideViewport(page);
  await page.goto(`/dashboard/${driveId}/${parent.pageId}`);
  await expect(rowCheckbox(page, 'Blocker')).toBeVisible();
  await showAllTasks(page);

  // Blocked while the sub-task is open.
  const selfBox = page.getByRole('checkbox', { name: /Complete this task/i });
  await selfBox.click();
  await expect(page.getByText(/Finish 1 sub-task first/i)).toBeVisible();
  await expect(selfBox).not.toBeChecked();

  // Clear the sub-task on this very screen; no reload, no refocus.
  // Wait on the header's own refresh rather than a sleep — that refresh IS the
  // fix, so if it never fires this times out instead of passing by luck.
  const headerRefreshed = page.waitForResponse(
    (r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/task'),
  );
  await rowCheckbox(page, 'Blocker').click();
  await expect(rowCheckbox(page, 'Blocker')).toBeChecked();
  await headerRefreshed;

  // Now it goes through.
  await page.getByRole('checkbox', { name: /Complete this task/i }).click();
  await expect(page.getByRole('checkbox', { name: /Reopen this task/i }))
    .toBeVisible({ timeout: 5000 });
});

test('an inline sub-task row creates under the task being viewed', async ({ page, request, driveId }) => {
  const listPageId = await createList(request, driveId, `Tree D ${Date.now()}`);
  const parent = await createTask(request, listPageId, 'Holder');
  await createTask(request, parent.pageId, 'Existing');

  await wideViewport(page);
  await page.goto(`/dashboard/${driveId}/${listPageId}`);
  await expect(rowCheckbox(page, 'Holder')).toBeVisible();
  await showAllTasks(page);
  await page.getByRole('button', { name: /Expand Holder/i }).click();
  await expect(rowCheckbox(page, 'Existing')).toBeVisible();

  await page.getByPlaceholder('+ Add a sub-task…').fill('Added inline');
  await page.getByPlaceholder('+ Add a sub-task…').press('Enter');

  await expect(rowCheckbox(page, 'Added inline')).toBeVisible({ timeout: 5000 });
  expect(page.url()).toContain(listPageId);

  // Visibility alone would also pass if the task had been created at the ROOT.
  // Collapsing Holder is what proves the parentage: a root row would stay.
  await page.getByRole('button', { name: /Collapse Holder/i }).click();
  await expect(rowCheckbox(page, 'Added inline')).toBeHidden();
  await expect(rowCheckbox(page, 'Existing')).toBeHidden();
  await expect(rowCheckbox(page, 'Holder')).toBeVisible();

  // ...and re-expanding brings it back, so it really is in Holder's subtree.
  await page.getByRole('button', { name: /Expand Holder/i }).click();
  await expect(rowCheckbox(page, 'Added inline')).toBeVisible();
});
