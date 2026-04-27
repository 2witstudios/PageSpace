import { test, expect } from '../fixtures/auth.fixture';

test('content typed in editor is persisted after navigating away and back', async ({ page, driveId }) => {
  // Create a page via API
  const csrfResponse = await page.request.get('/api/auth/csrf');
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };

  const createResponse = await page.request.post('/api/pages', {
    headers: { 'X-CSRF-Token': csrfToken },
    data: { title: `Persist Test ${Date.now()}`, type: 'DOCUMENT', driveId, parentId: null },
  });
  const { id: pageId } = (await createResponse.json()) as { id: string };

  // Navigate to the page
  await page.goto(`/dashboard/${driveId}/${pageId}`);
  await expect(page.locator('[contenteditable="true"]')).toBeVisible();

  // Type content into the TipTap editor
  const content = `persisted-${Date.now()}`;
  await page.locator('[contenteditable="true"]').click();
  await page.keyboard.type(content);

  // Wait for autosave PATCH
  await page.waitForResponse(`**/api/pages/${pageId}**`);

  // Navigate away then back
  await page.goto('/dashboard');
  await page.waitForURL('**/dashboard**');

  await page.goto(`/dashboard/${driveId}/${pageId}`);
  await expect(page.locator('[contenteditable="true"]')).toBeVisible();
  await expect(page.locator('[contenteditable="true"]')).toContainText(content);
});
