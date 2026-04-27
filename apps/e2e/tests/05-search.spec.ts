import { test, expect } from '../fixtures/data.fixture';

test('searching for a page title returns that page in results', async ({ page, seedPage }) => {
  const { title } = await seedPage();

  await page.goto('/dashboard');
  await page.waitForResponse('**/api/drives**');

  // Focus the inline search input
  const searchInput = page.locator('input[placeholder*="Search"]');
  await searchInput.click();
  await searchInput.fill(title);

  // Wait for search results to load
  await page.waitForResponse(`**/api/search?**`);

  await expect(page.getByText(title)).toBeVisible();
});
