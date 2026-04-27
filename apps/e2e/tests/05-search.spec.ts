import { test, expect } from '../fixtures/data.fixture';

test('searching for a page title returns that page in results', async ({ page, seedPage }) => {
  const { title } = await seedPage();

  const drivesLoaded = page.waitForResponse('**/api/drives**');
  await page.goto('/dashboard');
  await drivesLoaded;

  // Focus the inline search input
  const searchInput = page.locator('input[placeholder*="Search"]');
  await searchInput.click();

  const searchResponse = page.waitForResponse('**/api/search?**');
  await searchInput.fill(title);
  await searchResponse;

  // Use .first() to avoid strict-mode error if title appears in multiple nodes
  await expect(page.getByText(title).first()).toBeVisible();
});
