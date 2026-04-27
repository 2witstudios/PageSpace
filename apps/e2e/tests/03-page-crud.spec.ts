import { test, expect } from '../fixtures/auth.fixture';

test('creating a Document page navigates to an empty editor', async ({ page, driveId }) => {
  await page.goto(`/dashboard/${driveId}`);

  // Wait for the sidebar to render (drives API response)
  await page.waitForResponse('**/api/drives**');

  // Open quick-create palette (Alt+N)
  await page.keyboard.press('Alt+n');

  // Phase 1: select Document type
  await page.waitForSelector('[role="dialog"]');
  await page.getByRole('option', { name: /Document/i }).click();

  // Phase 2: name entry — default name is pre-filled, click Create
  const [createResponse] = await Promise.all([
    page.waitForResponse('**/api/pages**'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);

  expect(createResponse.status()).toBe(201);

  // Should navigate to /dashboard/<driveId>/<pageId>
  await page.waitForURL(`**/dashboard/${driveId}/**`);
  await expect(page.locator('[contenteditable="true"]')).toBeVisible();
});
