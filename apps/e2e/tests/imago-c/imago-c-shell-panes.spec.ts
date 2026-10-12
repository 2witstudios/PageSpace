import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/auth.fixture';
import { deleteUsers, hydrated, imagoPath, imagoUser, signIn } from '../../fixtures/imago.fixture';
import { attachBoard, expectWidth, seedCanon, type Canon } from '../../fixtures/imago-c.fixture';

/**
 * # Section and settings panes (IMC-1.11)
 *
 * Stage-2 screens (Chat, Files, Messages, Tasks with nothing open) carry a 300px pane; drive
 * settings and the account carry a 260px nav pane headed "Drive settings" / "Account" in the
 * SPEC's fixed order, the current row marked aria-current="page".
 */
const pane = (page: Page) => page.locator('[data-slot="list"] section').first();

test.describe('imago-c section and settings panes', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  const created: string[] = [];
  let canon: Canon;
  let userPage: Page;

  test.beforeEach(async ({ page }) => {
    const user = await imagoUser('Jono');
    created.push(user.id);
    canon = await seedCanon(user.id);
    await signIn(page, user, imagoPath(canon.driveId));
    await hydrated(page);
    userPage = page;
  });
  test.afterAll(async () => deleteUsers(created));

  for (const [section, title] of [['', 'Chat history'], ['files', 'Files'], ['messages', 'Messages'], ['tasks', 'Tasks']] as const) {
    test(`stage 2 ${section || 'chat'}: a 300px pane with Close sidebar`, async () => {
      await userPage.goto(imagoPath(canon.driveId, section));
      await hydrated(userPage);
      const left = userPage.getByRole('region', { name: title });
      await expectWidth(left, 300);
      await expect(left.getByRole('button', { name: 'Close sidebar' })).toBeVisible();
    });
  }

  test('drive settings: the nav in SPEC order', async ({}, testInfo) => {
    await userPage.goto(imagoPath(canon.driveId, 'settings/general'));
    await hydrated(userPage);
    const nav = pane(userPage);
    await expect(nav).toHaveAttribute('aria-label', 'Drive settings');
    await expectWidth(nav, 260);
    await expect(nav.getByRole('navigation', { name: 'Drive settings' }).getByRole('link')).toHaveText([
      'Overview', 'General', 'Members & roles', 'Integrations', 'Commands', 'Context', 'Backups', 'Domains', 'Danger zone',
    ]);
    await expect(nav.getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
    await attachBoard(testInfo, userPage, 'C-Settings-General');
  });

  test('account: the grouped nav in SPEC order', async ({}, testInfo) => {
    await userPage.goto('/imago/account/display');
    await hydrated(userPage);
    const nav = pane(userPage);
    await expect(nav).toHaveAttribute('aria-label', 'Account');
    await expectWidth(nav, 260);
    const links = nav.getByRole('navigation', { name: 'Account' }).getByRole('link');
    await expect(links.first()).toHaveText('Overview');
    await expect(nav.getByText('You', { exact: true })).toBeVisible();
    await expect(nav.getByText('Plan & data', { exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Display' })).toHaveAttribute('aria-current', 'page');
    await attachBoard(testInfo, userPage, 'C-Account-Display');
  });
});
