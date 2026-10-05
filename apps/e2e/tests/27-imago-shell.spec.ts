import type { Locator, Page } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import { provisionHomeDriveIfNeeded } from '@pagespace/lib/onboarding/home-drive';
import { test, expect } from '../fixtures/auth.fixture';
import {
  deleteUsers,
  emailedMagicLink,
  hydrated,
  imagoPath,
  imagoUser,
  pathnameIs,
  shell,
} from '../fixtures/imago.fixture';
import { getSeedState } from '../fixtures/seed-state';

/**
 * # The imago shell never remounts (IMG-3.5)
 *
 * The first browser spec for apps/imago. It runs on one origin, as production does: the e2e
 * proxy (support/e2e-proxy.ts) serves /imago from apps/imago and everything else — classic's
 * sign-in and /api included — from web. That is what makes the signed-out round trip real:
 * imago redirects to /auth/signin?next=/imago/…, and sign-in returns to that path on the same
 * origin. (Under `next dev` on its own port imago sends sign-in to web's origin, which then
 * returns to a /imago path web does not serve.)
 *
 * imago runs as a PRODUCTION build (`next build`, served by its standalone server), as it ships:
 * the production CSP has no 'unsafe-eval'. (`next dev` hydrates too, since its CSP adds
 * 'unsafe-eval' in development only; spec 26 proves that.)
 *
 * ## Requires
 *
 *  - The CI e2e topology (.github/workflows/ci.yml, job `e2e`): web, realtime, and the proxy on
 *    E2E_BASE_URL with E2E_IMAGO_TARGET pointing at imago's standalone server, started with
 *    IMAGO_ENABLED=true and WEB_APP_URL set to the proxy's origin.
 *
 * ## Proof technique
 *
 * A remount replaces DOM nodes, so the spec writes a JS property (`__probe`) onto the live
 * rail and shell nodes and reads it back after navigating. Only the same node can still carry
 * it; a server-rendered replacement or a full document load cannot. A reload is the negative
 * control: it must drop the probe, or the check could not see a remount at all.
 */

type Probed = HTMLElement & { __probe?: string };

const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const listPane = (page: Page) => page.locator('[data-slot="list"]');
const railLink = (page: Page, name: string) => rail(page).getByRole('link', { name, exact: true });

/** Acting on the inert server-rendered markup would not reach React: wait for the shell to hydrate. */
const whenHydrated = async (page: Page, control: Locator): Promise<Locator> => {
  await hydrated(page);
  return control;
};

const tag = (locator: Locator, value: string) =>
  locator.evaluate((node, probe) => {
    (node as Probed).__probe = probe;
  }, value);

const probeOf = (locator: Locator) => locator.evaluate((node) => (node as Probed).__probe ?? null);

const widthOf = (locator: Locator) => locator.evaluate((node) => node.getBoundingClientRect().width);

let homeDriveId: string;

test.beforeAll(async () => {
  // The auth fixture's user, given the Home drive every user gets at sign-in.
  ({ driveId: homeDriveId } = await provisionHomeDriveIfNeeded(getSeedState().userId));
});

test.describe('signed in', () => {
  test('/imago lands on the Home drive chat stage', async ({ page }) => {
    await page.goto('/imago');

    await page.waitForURL(pathnameIs(imagoPath(homeDriveId)));
    await expect(shell(page)).toHaveAttribute('data-section', 'chat');
    // The chat's own list is its history of past chats (IMG-6.5).
    await expect(shell(page)).toHaveAttribute('data-list', 'list');
    await expect(listPane(page).getByRole('region', { name: 'Chat history' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Chat', exact: true })).toBeVisible();
    await expect(railLink(page, 'Chat')).toHaveAttribute('aria-current', 'page');
  });

  test('the rail and shell keep their DOM nodes across chat → files → settings → chat', async ({
    page,
  }) => {
    await page.goto(imagoPath(homeDriveId));
    await whenHydrated(page, railLink(page, 'Files'));
    await tag(rail(page), 'rail');
    await tag(shell(page), 'shell');

    const stops = [
      { link: 'Files', section: 'files', path: imagoPath(homeDriveId, 'files') },
      { link: 'Settings', section: 'settings', path: imagoPath(homeDriveId, 'settings') },
      { link: 'Chat', section: 'chat', path: imagoPath(homeDriveId) },
    ];
    for (const stop of stops) {
      await railLink(page, stop.link).click();
      await page.waitForURL(pathnameIs(stop.path));
      await expect(shell(page)).toHaveAttribute('data-section', stop.section);
      expect(await probeOf(rail(page)), `rail node after ${stop.link}`).toBe('rail');
      expect(await probeOf(shell(page)), `shell node after ${stop.link}`).toBe('shell');
    }

    // Negative control: a real remount (a document reload) must drop the probe.
    await page.reload();
    await expect(shell(page)).toHaveAttribute('data-section', 'chat');
    expect(await probeOf(rail(page))).toBeNull();
    expect(await probeOf(shell(page))).toBeNull();
  });

  test('× on the files list leaves Files for the chat and its history', async ({ page }) => {
    await page.goto(imagoPath(homeDriveId, 'files'));
    await expect(shell(page)).toHaveAttribute('data-list', 'list');
    expect(await widthOf(listPane(page))).toBeGreaterThan(0);
    await expect(listPane(page)).not.toHaveAttribute('inert');

    const close = await whenHydrated(page, page.getByRole('link', { name: 'Close Files' }));
    await close.click();

    await page.waitForURL(pathnameIs(imagoPath(homeDriveId)));
    await expect(shell(page)).toHaveAttribute('data-section', 'chat');
    await expect(listPane(page).getByRole('region', { name: 'Chat history' })).toBeVisible();
    await expect(listPane(page)).not.toHaveAttribute('inert');
  });

  test('× on the chat history hides it to width 0 and inert; the hamburger brings it back', async ({
    page,
  }) => {
    const path = imagoPath(homeDriveId);
    await page.goto(path);
    await expect(shell(page)).toHaveAttribute('data-list', 'list');
    expect(await widthOf(listPane(page))).toBeGreaterThan(0);

    const hide = await whenHydrated(page, page.getByRole('button', { name: 'Hide Chat history' }));
    await hide.click();

    // View state, not a route: there is nowhere to step back to from the chat.
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(shell(page)).toHaveAttribute('data-list', 'closed');
    await expect(shell(page)).toHaveAttribute('data-list-hidden', 'true');
    await expect.poll(() => widthOf(listPane(page))).toBe(0);
    await expect(listPane(page)).toHaveAttribute('inert', '');
    await expect(listPane(page)).toHaveAttribute('aria-hidden', 'true');

    await page.getByRole('button', { name: 'Show Chat history' }).click();
    await expect(shell(page)).toHaveAttribute('data-list', 'list');
    await expect.poll(() => widthOf(listPane(page))).toBeGreaterThan(0);
    await expect(listPane(page)).not.toHaveAttribute('inert');
  });

  test('× on the files tree beside an open page hides it to width 0 and inert', async ({
    page,
  }) => {
    const filePage = await factories.createPage(homeDriveId, { title: 'Shell spec page' });
    const path = imagoPath(homeDriveId, `files/${filePage.id}`);
    await page.goto(path);
    await expect(shell(page)).toHaveAttribute('data-list', 'tree');
    expect(await widthOf(listPane(page))).toBeGreaterThan(0);

    const hide = await whenHydrated(page, page.getByRole('button', { name: 'Hide Files' }));
    await hide.click();

    // View state, not a route: the address and the open object stay.
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(shell(page)).toHaveAttribute('data-list', 'closed');
    await expect(shell(page)).toHaveAttribute('data-list-hidden', 'true');
    await expect.poll(() => widthOf(listPane(page))).toBe(0);
    await expect(listPane(page)).toHaveAttribute('inert', '');
    await expect(page.getByRole('button', { name: 'Show Files' })).toBeVisible();
  });

  /**
   * Every list-pane width painted from the click until the pane settles, one sample per
   * animation frame. Under a transition the pane passes through widths between closed and
   * open; with none it jumps straight there.
   */
  const paintedListWidths = async (page: Page): Promise<number[]> => {
    // Settings has no list, so Files slides its list open from width 0.
    await page.goto(imagoPath(homeDriveId, 'settings'));
    const files = await whenHydrated(page, railLink(page, 'Files'));
    await page.evaluate(() => {
      const pane = document.querySelector('[data-slot="list"]');
      const record = window as Window & { __widths?: number[] };
      record.__widths = [];
      const sample = () => {
        if (pane) record.__widths?.push(pane.getBoundingClientRect().width);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await files.click();
    await page.waitForURL(pathnameIs(imagoPath(homeDriveId, 'files')));
    await expect(shell(page)).toHaveAttribute('data-list', 'list');
    // Well past the 320ms pane transition, so a settled width is the final one.
    await page.waitForTimeout(800);
    return page.evaluate(() => (window as Window & { __widths?: number[] }).__widths ?? []);
  };

  const inBetween = (widths: number[]): number[] => {
    const open = widths[widths.length - 1];
    return widths.filter((width) => width > 0 && width < open);
  };

  test('under reduced motion, stages switch with no transition', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });

    const widths = await paintedListWidths(page);
    expect(widths[0]).toBe(0);
    expect(widths[widths.length - 1]).toBeGreaterThan(0);
    expect(inBetween(widths), `painted widths: ${widths.join(', ')}`).toEqual([]);
    const seconds = await listPane(page).evaluate((node) =>
      parseFloat(getComputedStyle(node).transitionDuration),
    );
    expect(seconds).toBeLessThan(0.001);
  });

  test('negative control: with motion allowed, the same switch animates through in-between widths', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    const widths = await paintedListWidths(page);
    expect(inBetween(widths).length, `painted widths: ${widths.join(', ')}`).toBeGreaterThan(0);
    const seconds = await listPane(page).evaluate((node) =>
      parseFloat(getComputedStyle(node).transitionDuration),
    );
    expect(seconds).toBeCloseTo(0.32, 2);
  });
});

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // The user this test signs in, and every row that hangs off them, goes when it ends.
  let created: string[] = [];
  test.afterEach(async () => {
    await deleteUsers(created);
    created = [];
  });

  test('an imago path redirects to sign-in and returns there after signing in', async ({ page }) => {
    const user = await imagoUser('Signed-out e2e');
    created = [user.id];
    const driveId = user.homeDriveId;
    const requested = imagoPath(driveId, 'files');

    await page.goto(requested);

    await page.waitForURL(pathnameIs('/auth/signin'));
    const next = new URL(page.url()).searchParams.get('next');
    expect(next).toBe(requested);
    expect(await page.context().cookies()).not.toContainEqual(
      expect.objectContaining({ name: 'session' }),
    );

    await page.goto(await emailedMagicLink(user.id, next ?? ''));

    await page.waitForURL(pathnameIs(requested));
    await expect(shell(page)).toHaveAttribute('data-section', 'files');
    await expect(railLink(page, 'Files')).toHaveAttribute('aria-current', 'page');
    expect(await page.context().cookies()).toContainEqual(
      expect.objectContaining({ name: 'session' }),
    );
  });
});
