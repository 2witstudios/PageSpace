import { test, expect, type BrowserContext } from '@playwright/test';
import { deleteUsers, imagoPath } from '../fixtures/imago.fixture';
import {
  filesReady,
  openSignedIn,
  seedFiles,
  settle,
  switchTheme,
  teamDrive,
  THEMES,
  visualBrowser,
  visualUser,
} from '../fixtures/imago-visual.fixture';

/**
 * # A changed design token fails imago's visual baselines (IMG-10.4)
 *
 * The negative control for 34-imago-visual.spec.ts. It opens the files surface exactly as 34
 * does, first proves it matches 34's committed baseline (tests/__screenshots__/files-<theme>-…),
 * then changes ONE design token — `--background`, the canvas colour, one tonal step (dark
 * oklch 0.17 → 0.19, light 0.995 → 0.975) — and requires the very same comparison to fail with
 * a pixel difference. A token is a CSS custom property on the root element (apps/imago/src/app/
 * globals.css), so setting it on <html> is what a changed value in globals.css does to the
 * rendered page, without a rebuild.
 *
 * Without the first half, a missing baseline would also make the second comparison throw and
 * the control would pass for the wrong reason; the message is matched for the same reason.
 *
 * ## Never while updating baselines
 *
 * Under `--update-snapshots=all` or `changed`, the second comparison would WRITE the changed
 * frame over 34's baseline instead of failing. So this spec refuses to run in those modes: it
 * fails at once, loudly, rather than skip or corrupt the baseline. The baseline workflow runs
 * only spec 34.
 */

test.setTimeout(120_000);

const TOKEN = '--background';
const CHANGED = { dark: 'oklch(0.19 0 0)', light: 'oklch(0.975 0.002 240)' } as const;
const DIFFERENT = /pixels \(ratio [\d.]+ of all image pixels\) are different/;

const contexts: BrowserContext[] = [];
let created: string[] = [];

test.beforeAll(() => {
  const mode = test.info().config.updateSnapshots;
  if (mode !== 'missing' && mode !== 'none') {
    throw new Error(
      `the token control must not run with --update-snapshots=${mode}: it would write a changed frame over spec 34's baseline`,
    );
  }
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await deleteUsers(created);
});

test('one design token changed fails the files baseline in dark and light', async ({ browser, baseURL }) => {
  const user = await visualUser('Ada Lovelace');
  created = [user.id];
  const driveId = await teamDrive(user);
  const { projects } = await seedFiles(driveId);
  const { context, page } = await visualBrowser(browser, baseURL ?? '', THEMES[0]);
  contexts.push(context);
  await openSignedIn(page, user, imagoPath(driveId, `files/${projects.id}`));

  for (const theme of THEMES) {
    if (theme !== THEMES[0]) await switchTheme(page, baseURL ?? '', theme);
    await settle(page, theme);
    await filesReady(page);

    // As shipped, the frame is 34's baseline.
    await expect(page).toHaveScreenshot(`files-${theme}.png`);

    // One token, one step: the canvas.
    const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.evaluate(
      ({ token, value }) => {
        document.documentElement.style.setProperty(token, `light-dark(${value}, ${value})`);
      },
      { token: TOKEN, value: CHANGED[theme] },
    );
    const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(after, 'the token change did not reach the page').not.toBe(before);

    await expect(
      expect(page).toHaveScreenshot(`files-${theme}.png`, { timeout: 5_000 }),
      `a ${TOKEN} change passed the ${theme} baseline`,
    ).rejects.toThrow(DIFFERENT);
  }
});
