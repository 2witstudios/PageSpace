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

  const checkbox = rowCheckbox(page, 'Alpha');
  await checkbox.click();

  // The tick is there before the network settles.
  await expect(checkbox).toBeChecked({ timeout: 1000 });
  await page.waitForTimeout(1500);
  expect(listGets, 'a completion should trigger no list refetch').toBe(0);
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

  await page.getByRole('button', { name: /Expand Parent/i }).click();
  await expect(rowCheckbox(page, 'Child')).toBeVisible();

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
});
