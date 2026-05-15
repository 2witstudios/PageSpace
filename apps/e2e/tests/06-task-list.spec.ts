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
