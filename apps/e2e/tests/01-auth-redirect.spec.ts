import { test, expect } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('redirects /dashboard to /auth/signin when unauthenticated', async ({ page }) => {
  await page.goto('/dashboard');
  await page.waitForURL('**/auth/signin**');
  expect(page.url()).toContain('/auth/signin');
});
