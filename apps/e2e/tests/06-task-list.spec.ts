import { test, expect } from '@playwright/test';
import { seedState } from '../fixtures/seed-state';

test('New Task button focuses the task input and creates a task', async ({ page, request }) => {
  // Seed a Task List page via API
  const csrfResponse = await request.get('/api/auth/csrf');
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const createResponse = await request.post('/api/pages', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: {
      title: `E2E Task List ${Date.now()}`,
      type: 'TASK_LIST',
      driveId: seedState.driveId,
      parentId: null,
    },
  });
  expect(createResponse.status()).toBe(201);
  const { id: pageId } = (await createResponse.json()) as { id: string };

  // Navigate to the task list page
  await page.goto(`/dashboard/${seedState.driveId}/${pageId}`);

  // Wait for the New Task button to appear (table view is default)
  const newTaskBtn = page.getByRole('button', { name: 'New Task' });
  await expect(newTaskBtn).toBeVisible();

  // Click it and assert the desktop input receives focus
  await newTaskBtn.click();
  const taskInput = page.locator('#new-task-input');
  await expect(taskInput).toBeFocused();

  // Type a task title and submit
  const taskTitle = `E2E task ${Date.now()}`;
  const [taskCreateResponse] = await Promise.all([
    page.waitForResponse(`**/api/pages/${pageId}/tasks`),
    page.keyboard.type(taskTitle).then(() => page.keyboard.press('Enter')),
  ]);
  expect(taskCreateResponse.status()).toBe(201);

  // Task title should appear in the list
  await expect(page.getByText(taskTitle).first()).toBeVisible();
});
