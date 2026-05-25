import { test, expect } from '../fixtures/auth.fixture';

test('New Task button focuses the task input and creates a task', async ({ page, request, driveId }) => {
  const csrfResponse = await request.get('/api/auth/csrf');
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const createResponse = await request.post('/api/pages', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: {
      title: `E2E Task List ${Date.now()}`,
      type: 'TASK_LIST',
      driveId,
      parentId: null,
    },
  });
  expect(createResponse.status()).toBe(201);
  const { id: pageId } = (await createResponse.json()) as { id: string };

  await page.goto(`/dashboard/${driveId}/${pageId}`);

  const newTaskBtn = page.getByRole('button', { name: 'New Task' });
  await expect(newTaskBtn).toBeVisible();

  await newTaskBtn.click();
  await expect(page.locator('#new-task-input')).toBeFocused();

  const taskTitle = `E2E task ${Date.now()}`;
  const [taskCreateResponse] = await Promise.all([
    page.waitForResponse(`**/api/pages/${pageId}/tasks`),
    page.keyboard.type(taskTitle).then(() => page.keyboard.press('Enter')),
  ]);
  expect(taskCreateResponse.status()).toBe(201);

  await expect(page.getByText(taskTitle).first()).toBeVisible();
});

test('clicking a task navigates to its page without a page-not-found error', async ({ page, request, driveId }) => {
  const csrfResponse = await request.get('/api/auth/csrf');
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const createResponse = await request.post('/api/pages', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: {
      title: `E2E Task List Nav ${Date.now()}`,
      type: 'TASK_LIST',
      driveId,
      parentId: null,
    },
  });
  expect(createResponse.status()).toBe(201);
  const { id: pageId } = (await createResponse.json()) as { id: string };

  await page.goto(`/dashboard/${driveId}/${pageId}`);

  const newTaskBtn = page.getByRole('button', { name: 'New Task' });
  await expect(newTaskBtn).toBeVisible();
  await newTaskBtn.click();

  const taskTitle = `E2E Nav Task ${Date.now()}`;
  const [taskCreateResponse] = await Promise.all([
    page.waitForResponse(`**/api/pages/${pageId}/tasks`),
    page.keyboard.type(taskTitle).then(() => page.keyboard.press('Enter')),
  ]);
  expect(taskCreateResponse.status()).toBe(201);
  const { pageId: taskPageId } = (await taskCreateResponse.json()) as { pageId: string };

  // Wait for the task title to appear then click through to its document page
  await expect(page.getByText(taskTitle).first()).toBeVisible();
  await page.getByText(taskTitle).first().click();

  // Wait for navigation to the task's document page
  await page.waitForURL(`**/dashboard/${driveId}/${taskPageId}`, { timeout: 8000 });

  // The fallback fetch should resolve the page even if the tree hasn't revalidated yet
  await expect(page.getByText('Page not found in the current tree.')).not.toBeVisible();
  await expect(page.getByText('Page not found.')).not.toBeVisible();
});
