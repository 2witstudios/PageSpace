import { test, expect } from '../fixtures/auth.fixture';

test('shows drive in sidebar after authenticated load', async ({ page, driveId }) => {
  const [drivesResponse] = await Promise.all([
    page.waitForResponse('**/api/drives**'),
    page.goto('/dashboard'),
  ]);

  const drives = (await drivesResponse.json()) as Array<{ id: string; name: string }>;
  const seededDrive = drives.find((d) => d.id === driveId);
  expect(seededDrive).toBeTruthy();

  await expect(page.getByText(seededDrive!.name)).toBeVisible();
});
