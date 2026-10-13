import type { Locator, Page } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import { provisionHomeDriveIfNeeded } from '../../../packages/lib/src/onboarding/home-drive';
import { test, expect } from '../fixtures/auth.fixture';
import { getSeedState } from '../fixtures/seed-state';

/**
 * # Imago drive settings and account (IMG-10.1)
 *
 * Drives the real settings object against the real drive, members and imago-access routes:
 * renaming a drive and toggling Imago access are read back from apps/web after a reload, and
 * the Home drive offers neither action. No route is stubbed.
 *
 * ## Requires
 *
 *  - The CI e2e topology spec 27 runs on (.github/workflows/ci.yml, job `e2e`): web, realtime
 *    and the proxy serving a production build of apps/imago at /imago.
 */

const imagoPath = (driveId: string, section = '') =>
  section === '' ? `/imago/${driveId}` : `/imago/${driveId}/${section}`;

/** Acting on the inert server-rendered node would not reach React: wait for its props. */
const hydrated = async (page: Page, control: Locator): Promise<Locator> => {
  await page.waitForFunction(
    (node) => node !== null && Object.keys(node).some((key) => key.startsWith('__reactProps$')),
    await control.elementHandle(),
  );
  return control;
};

const imagoAccess = async (page: Page, driveId: string): Promise<boolean> => {
  const response = await page.request.get(`/api/drives/${driveId}/imago-access`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { enabled: boolean }).enabled;
};

let homeDriveId: string;

test.beforeAll(async () => {
  // The auth fixture's user, given the Home drive and the Imago agents every user gets at sign-in.
  ({ driveId: homeDriveId } = await provisionHomeDriveIfNeeded(getSeedState().userId));
});

test.describe('drive settings', () => {
  test('an owner renames the drive and toggles Imago access', async ({ page }) => {
    const drive = await factories.createDrive(getSeedState().userId, { name: 'Settings spec drive' });

    await page.goto(imagoPath(drive.id, 'settings'));

    const name = await hydrated(page, page.getByRole('textbox', { name: 'Drive name' }));
    await expect(name).toHaveValue('Settings spec drive');
    // Members are read-only: the owner is listed, and nothing in the list is a control.
    const members = page.getByRole('list', { name: 'Members' });
    await expect(members).toContainText('Owner');
    await expect(members.getByRole('button')).toHaveCount(0);

    await name.fill('Settings spec renamed');
    await name.press('Enter');
    await expect
      .poll(async () => ((await (await page.request.get(`/api/drives/${drive.id}`)).json()) as { name: string }).name)
      .toBe('Settings spec renamed');

    const toggle = await hydrated(page, page.getByRole('switch', { name: 'Imago access' }));
    await expect(toggle).toHaveAttribute('aria-checked', String(await imagoAccess(page, drive.id)));
    const before = await imagoAccess(page, drive.id);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', String(!before));
    await expect(toggle).toBeEnabled();
    await expect.poll(() => imagoAccess(page, drive.id)).toBe(!before);

    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Drive name' })).toHaveValue('Settings spec renamed');
    await expect(page.getByRole('switch', { name: 'Imago access' })).toHaveAttribute('aria-checked', String(!before));
  });

  test('the Home drive hides what its guards forbid', async ({ page }) => {
    await page.goto(imagoPath(homeDriveId, 'settings'));

    await expect(page.getByRole('heading', { name: 'Imago access' })).toBeVisible();
    await expect(
      page.getByText('Imago lives in your Home drive, so it cannot be kept out of it.'),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Drive name' })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Imago access' })).toHaveCount(0);
  });
});

test.describe('account', () => {
  test('opens account settings within the persistent Imago shell', async ({ page }) => {
    await page.goto('/imago/account');

    const links = page.locator('[data-slot="object"]').getByRole('link');
    await expect(links.first()).toBeVisible();
    const hrefs = await links.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href')));
    expect(hrefs).toContain('/imago/account/account');
    expect(hrefs).toContain('/imago/account/integrations');

    await links.filter({ hasText: 'Account' }).first().click();
    await page.waitForURL((url) => url.pathname === '/imago/account/account');
  });
});
