import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/auth.fixture';
import { deleteUsers, hydrated, imagoPath, imagoUser, signIn } from '../../fixtures/imago.fixture';
import { attachBoard, expectHeight, expectWidth, landmarks, seedCanon, type Canon } from '../../fixtures/imago-c.fixture';

/**
 * # The v3 shell on C-Files-Doc (IMC-1.12)
 *
 * Drives every state of the board's `_v32Vals`/`renderVals` machine on the CANON drive, in the
 * real app on real APIs: three docked columns, the sidebar closed and reopened, Imago collapsed
 * to the Ask pill and back, the page closed (Imago as the ground, tabs kept, none selected),
 * Imago closed to the empty middle and reopened with Ask Imago, a tab closed to its neighbour,
 * and every tab closed. Geometry is the board's: spine 72, tab bar 40, heads 48, pane 260,
 * Imago 360. Each state attaches the app beside the board reference.
 */

const VIEWPORT = { width: 1440, height: 900 } as const;

const object = (page: Page) => page.locator('[data-slot="object"]');
const pane = (page: Page) => page.locator('[data-slot="list"] section').first();
const tab = (page: Page, name: string) => landmarks(page).tabBar.getByRole('tab', { name });

test.describe('imago-c shell on C-Files-Doc', () => {
  test.use({ viewport: VIEWPORT });
  const created: string[] = [];
  let canon: Canon;

  test.beforeEach(async ({ page }) => {
    const user = await imagoUser('Jono');
    created.push(user.id);
    canon = await seedCanon(user.id);
    // Open the three canon tabs in order, ending on Q4 Launch Plan, as the board shows them.
    await signIn(page, user, imagoPath(canon.driveId, `files/${canon.pages['launch-ops']}`));
    await hydrated(page);
    for (const title of ['Pricing Model', 'Q4 Launch Plan']) {
      await page.goto(imagoPath(canon.driveId, `files/${canon.pages[title]}`));
      await hydrated(page);
    }
  });
  test.afterAll(async () => deleteUsers(created));

  test('default: three docked columns under the tab bar', async ({ page }, testInfo) => {
    const { spine, tabBar, imago } = landmarks(page);
    await expect(tab(page, 'Q4 Launch Plan')).toHaveAttribute('aria-selected', 'true');
    await expect(tabBar.getByRole('tab')).toHaveCount(3);
    await expectWidth(spine, 72);
    await expectHeight(tabBar, 40);
    await expectWidth(pane(page), 260);
    await expectWidth(imago, 360);
    await expectHeight(imago.locator('header').first(), 48);
    await expectHeight(object(page).locator('header').first(), 48);
    await expect(pane(page).getByRole('button', { name: 'Close sidebar' })).toBeVisible();
    await expect(imago.getByRole('button', { name: 'Collapse Imago' })).toBeVisible();
    await expect(object(page).getByRole('link', { name: 'Close page' })).toBeVisible();
    // IMC-1.9: the page head is the page's only header — its path, Share and Page actions.
    const head = object(page).locator('header').first();
    await expect(head.getByRole('list', { name: 'Path' })).toHaveText(/Launch\s*›\s*Q4 Launch Plan/);
    await expect(head.getByRole('button', { name: 'Share' })).toBeVisible();
    await expect(head.getByLabel('Page actions').first()).toBeVisible();
    await expect(object(page).getByRole('button', { name: 'History' })).toBeHidden();
    // IMC-1.10: a document's tools sit in the 44px Formatting strip under the head.
    await expectHeight(object(page).getByRole('toolbar', { name: 'Formatting' }), 44);
    await attachBoard(testInfo, page, 'C-Files-Doc');
  });

  test('sidebar closed and reopened from the page head', async ({ page }, testInfo) => {
    await pane(page).getByRole('button', { name: 'Close sidebar' }).click();
    const show = object(page).getByRole('button', { name: 'Show sidebar' });
    await expect(show).toBeVisible();
    await expectWidth(page.locator('[data-slot="list"]'), 0);
    await attachBoard(testInfo, page, 'C-Files-Doc');
    await show.click();
    await expectWidth(pane(page), 260);
  });

  test('Imago collapsed to the Ask pill and back', async ({ page }) => {
    const { imago } = landmarks(page);
    await imago.getByRole('button', { name: 'Collapse Imago' }).click();
    await expect(page.locator('[data-slot="chat"]')).toHaveAttribute('aria-hidden', 'true');
    const ask = object(page).getByRole('button', { name: 'Ask', exact: true });
    await expect(ask).toBeVisible();
    await ask.click();
    await expectWidth(imago, 360);
    await expect(ask).toBeHidden();
  });

  test('page closed: Imago is the ground, the tabs stay, none selected', async ({ page }, testInfo) => {
    await object(page).getByRole('link', { name: 'Close page' }).click();
    await page.waitForURL((url) => url.pathname === imagoPath(canon.driveId, 'files'));
    const { imago, tabBar } = landmarks(page);
    await expect(imago.getByRole('button', { name: 'Close Imago' })).toBeVisible();
    await expect(imago.getByRole('button', { name: 'Collapse Imago' })).toHaveCount(0);
    await expect(tabBar.getByRole('tab')).toHaveCount(3);
    await expect(tabBar.getByRole('tab', { selected: true })).toHaveCount(0);
    await attachBoard(testInfo, page, 'C-Files-Doc');
    // Closing the sidebar now puts Show sidebar at the start of Imago's head.
    await pane(page).getByRole('button', { name: 'Close sidebar' }).click();
    await expect(imago.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
  });

  test('empty middle after Close Imago, and Ask Imago brings it back', async ({ page }, testInfo) => {
    await object(page).getByRole('link', { name: 'Close page' }).click();
    const { imago, emptyMiddle } = landmarks(page);
    await imago.getByRole('button', { name: 'Close Imago' }).click();
    await expect(emptyMiddle).toBeVisible();
    await expect(emptyMiddle.getByRole('heading', { name: 'Nothing open' })).toBeVisible();
    await expect(emptyMiddle.getByText('Pick a page from the sidebar, or ask Imago.')).toBeVisible();
    await expect(emptyMiddle.getByRole('link')).toHaveCount(3);
    await attachBoard(testInfo, page, 'C-Files-Doc');
    await emptyMiddle.getByRole('button', { name: 'Ask Imago' }).click();
    await expect(imago.getByRole('button', { name: 'Close Imago' })).toBeVisible();
  });

  test('closing the active tab moves to its neighbour; closing all closes the middle', async ({ page }) => {
    const { tabBar, imago } = landmarks(page);
    await tabBar.getByRole('button', { name: 'Close Q4 Launch Plan' }).click();
    await expect(tab(page, 'Pricing Model')).toHaveAttribute('aria-selected', 'true');
    await tabBar.getByRole('button', { name: 'Close Pricing Model' }).click();
    await expect(tab(page, '#launch-ops')).toHaveAttribute('aria-selected', 'true');
    await tabBar.getByRole('button', { name: 'Close #launch-ops' }).click();
    await expect(tabBar.getByRole('tab')).toHaveCount(0);
    await expect(imago.getByRole('button', { name: 'Close Imago' })).toBeVisible();
  });

  test('a tab reopens the middle with its page', async ({ page }) => {
    await object(page).getByRole('link', { name: 'Close page' }).click();
    await tab(page, 'Pricing Model').getByRole('link').click();
    await page.waitForURL((url) => url.pathname.endsWith(canon.pages['Pricing Model'] ?? ''));
    await expect(tab(page, 'Pricing Model')).toHaveAttribute('aria-selected', 'true');
    await expect(object(page).getByRole('link', { name: 'Close page' })).toBeVisible();
  });
});
