import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import {
  deleteUsers,
  freshBrowser,
  hydrated,
  imagoPath,
  imagoUser,
  pathnameIs,
  signIn,
  type ImagoUser,
} from '../fixtures/imago.fixture';

/**
 * # The ⌘K command palette (IMG-10.2)
 *
 * One user, signed in through the real magic-link route, against real web and imago servers
 * and a real database: the palette asks apps/web's search, which decides what the viewer may
 * see. Nothing is mocked, and the keyboard alone drives every step.
 *
 * The viewer, Ada, owns a team drive with a document, a channel, a task list and an agent; is
 * a member of Grace's shared drive with one page; and has no way into Grace's private drive,
 * whose page matches the same query. That page must never show, in either scope.
 *
 * ## Requires
 *
 * The same topology as 27-imago-shell.spec.ts (the CI `e2e` job): imago's production build
 * behind the e2e proxy at /imago.
 *
 * ## Same document
 *
 * Every jump must be a client navigation inside the one shell, not a page load: a probe on
 * `window` set before the first jump must survive to the end.
 */

type Probed = Window & { __probe?: string };

const tagDocument = (page: Page) =>
  page.evaluate(() => {
    (window as Probed).__probe = 'same document';
  });
const probeOf = (page: Page) => page.evaluate(() => (window as Probed).__probe ?? null);

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search' });
const field = (page: Page) => palette(page).getByRole('combobox', { name: 'Search pages' });
const results = (page: Page) => palette(page).getByRole('option');

/** Opens the palette from the keyboard: ⌘K on a Mac, Ctrl-K on the CI's Linux. */
const openPalette = async (page: Page) => {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page)).toBeVisible();
  await expect(field(page)).toBeFocused();
};

/** Moves the highlight down to the result named `title` with ↓ alone, then opens it with Enter. */
const pick = async (page: Page, title: string) => {
  const names = await results(page).allTextContents();
  const index = names.findIndex((name) => name.startsWith(title));
  expect(index, `${title} is listed`).toBeGreaterThanOrEqual(0);
  for (let step = 0; step < index; step += 1) await page.keyboard.press('ArrowDown');
  await expect(results(page).nth(index)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(palette(page)).toHaveCount(0);
};

let created: string[] = [];
const contexts: BrowserContext[] = [];

let ada: ImagoUser;
let word: string;
let alphaId: string;
let sharedId: string;
const ids: Record<'document' | 'channel' | 'tasks' | 'agent' | 'shared' | 'secret', string> = {
  document: '',
  channel: '',
  tasks: '',
  agent: '',
  shared: '',
  secret: '',
};

test.beforeEach(async () => {
  const run = Math.random().toString(36).slice(2, 8);
  // One word no other spec's data holds, so the search answers with this run's pages only.
  word = `orbit${run}`;
  ada = await imagoUser(`Ada ${run}`);
  const grace = await imagoUser(`Grace ${run}`);
  created = [ada.id, grace.id];

  ({ id: alphaId } = await factories.createDrive(ada.id, { name: `Alpha ${run}` }));
  ids.document = (await factories.createPage(alphaId, { title: `${word} plan`, type: 'DOCUMENT' })).id;
  ids.channel = (await factories.createPage(alphaId, { title: `${word} crew`, type: 'CHANNEL', isPrivate: false })).id;
  ids.tasks = (await factories.createPage(alphaId, { title: `${word} tasks`, type: 'TASK_LIST' })).id;
  ids.agent = (await factories.createPage(alphaId, { title: `${word} agent`, type: 'AI_CHAT' })).id;

  ({ id: sharedId } = await factories.createDrive(grace.id, { name: `Shared ${run}` }));
  await factories.createDriveMember(sharedId, ada.id, { role: 'MEMBER' });
  ids.shared = (await factories.createPage(sharedId, { title: `${word} shared`, type: 'DOCUMENT' })).id;

  const { id: secretDrive } = await factories.createDrive(grace.id, { name: `Secret ${run}` });
  ids.secret = (await factories.createPage(secretDrive, { title: `${word} secret`, type: 'DOCUMENT' })).id;
});

test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await deleteUsers(created);
});

const signedIn = async (browser: Parameters<typeof freshBrowser>[0], baseURL: string | undefined, next: string) => {
  const opened = await freshBrowser(browser, baseURL ?? '');
  contexts.push(opened.context);
  await signIn(opened.page, ada, next);
  await hydrated(opened.page);
  await tagDocument(opened.page);
  return opened.page;
};

test('⌘K searches the open drive and jumps to a channel, a task list, a document and an agent by keyboard', async ({
  browser,
  baseURL,
}) => {
  const page = await signedIn(browser, baseURL, imagoPath(alphaId));

  await openPalette(page);
  await page.keyboard.type(word);
  await expect(results(page)).toHaveCount(4);
  expect((await results(page).allTextContents()).sort()).toEqual(
    [`${word} agent`, `${word} crew`, `${word} plan`, `${word} tasks`].sort(),
  );

  await pick(page, `${word} crew`);
  await page.waitForURL(pathnameIs(imagoPath(alphaId, `messages/${ids.channel}`)));

  await openPalette(page);
  await expect(field(page)).toHaveValue('');
  await page.keyboard.type(word);
  await expect(results(page)).toHaveCount(4);
  await pick(page, `${word} tasks`);
  await page.waitForURL(pathnameIs(imagoPath(alphaId, `tasks/${ids.tasks}`)));

  await openPalette(page);
  await page.keyboard.type(word);
  await expect(results(page)).toHaveCount(4);
  await pick(page, `${word} plan`);
  await page.waitForURL(pathnameIs(imagoPath(alphaId, `files/${ids.document}`)));

  await openPalette(page);
  await page.keyboard.type(word);
  await expect(results(page)).toHaveCount(4);
  await pick(page, `${word} agent`);
  await page.waitForURL(pathnameIs(imagoPath(alphaId)));
  await expect(page.getByRole('region', { name: 'Chat', exact: true }).getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue(ids.agent);

  // Escape closes without going anywhere.
  await openPalette(page);
  await page.keyboard.press('Escape');
  await expect(palette(page)).toHaveCount(0);
  await expect(page).toHaveURL((url) => url.pathname === imagoPath(alphaId));

  expect(await probeOf(page), 'a jump reloaded the page').toBe('same document');
});

test('"Include all workspaces" reaches a shared drive and never a drive the viewer cannot open', async ({
  browser,
  baseURL,
}) => {
  const page = await signedIn(browser, baseURL, imagoPath(alphaId, 'files'));

  await openPalette(page);
  await page.keyboard.type(word);
  await expect(results(page)).toHaveCount(4);
  await expect(palette(page)).not.toContainText(`${word} shared`);
  await expect(palette(page)).not.toContainText(`${word} secret`);

  // Tab to the toggle and tick it with Space; focus goes back to the field with Shift-Tab.
  await page.keyboard.press('Tab');
  const toggle = palette(page).getByRole('checkbox', { name: 'Include all workspaces' });
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Shift+Tab');
  await expect(field(page)).toBeFocused();

  await expect(results(page)).toHaveCount(5);
  await expect(results(page).filter({ hasText: `${word} shared` })).toContainText('Shared');
  await expect(palette(page)).not.toContainText(`${word} secret`);

  await pick(page, `${word} shared`);
  await page.waitForURL(pathnameIs(imagoPath(sharedId, `files/${ids.shared}`)));
  expect(await probeOf(page), 'the jump reloaded the page').toBe('same document');
});
