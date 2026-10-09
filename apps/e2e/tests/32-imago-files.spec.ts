import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import {
  deleteUsers,
  freshBrowser,
  hydrated,
  imagoPath,
  imagoUser,
  pathnameIs,
  shell,
  signIn,
  type ImagoUser,
} from '../fixtures/imago.fixture';

/**
 * # Files in imago, end to end (IMG-7.7)
 *
 * A user signed in through the real magic-link route, in a browser of their own, against real
 * web, realtime and imago servers and a real database: creating a page from the tree and typing
 * into it (POST and PATCH /api/pages through apps/web), browsing folders in the files object, and
 * filtering the tree. Nothing is mocked and nothing is seeded into the page under test: the
 * document the first test types into is the one its click creates.
 *
 * ## Requires
 *
 * The same topology as 27-imago-shell.spec.ts (the CI `e2e` job): imago's production build behind
 * the e2e proxy at /imago (`E2E_IMAGO_TARGET`), so the shipped CSP is the one under test.
 *
 * And a bucket: apps/web writes each page version's content to S3, so the create and the save
 * 500 without one. Web is started with AWS_ENDPOINT_URL_S3 at Playwright's mock server's S3
 * stand-in (support/mock-s3.ts, `E2E_MOCK_S3_PORT`, default 4997), as it is pointed at the mock
 * AI provider: storage is not what this spec tests.
 *
 * ## Waits
 *
 * No sleeps. Each step waits for what it caused: the create's POST answer and the address it
 * opens, the save's PATCH answer and the editor's "Saved" state, a link's URL.
 *
 * ## In the page, not a document load
 *
 * Opening a folder, a child folder and a page are client navigations inside the shell. A JS
 * probe on `window` from before the first click must survive to the last; a full document load
 * would drop it (the reload in the first test is the control: there, persistence has to come
 * from the server, because nothing in the page survives it).
 */

type Probed = Window & { __probe?: string };

const listPane = (page: Page) => page.locator('[data-slot="list"]');
const fileTree = (page: Page) => listPane(page).getByRole('navigation', { name: 'File tree', exact: true });
/** A tree row's link; its accessible name is the page's name, then a folder's item count. */
const treeLink = (scope: Locator, name: string) => scope.getByRole('link', { name: new RegExp(`^${name}\\b`) });
const documentBody = (page: Page) => page.locator('.retained-ui .tiptap').first();

const tagDocument = (page: Page) =>
  page.evaluate(() => {
    (window as Probed).__probe = 'same document';
  });
const probeOf = (page: Page) => page.evaluate(() => (window as Probed).__probe ?? null);

let user: ImagoUser;
let driveId: string;
const contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  user = await imagoUser(`Files ${Math.random().toString(36).slice(2, 8)}`);
  driveId = user.homeDriveId;
});

// In teardown, not inline, so a failing assertion never leaks a browser or a row.
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await deleteUsers([user.id]);
});

/** The user's own browser, signed in and hydrated on `path`. */
const openAt = async (
  browser: Parameters<typeof freshBrowser>[0],
  baseURL: string | undefined,
  path: string,
): Promise<Page> => {
  const { context, page } = await freshBrowser(browser, baseURL ?? '');
  contexts.push(context);
  await signIn(page, user, path);
  await hydrated(page);
  return page;
};

test('a page created from the tree keeps the text typed into it across a reload', async ({ browser, baseURL }) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, 'files'));
  await expect(fileTree(page)).toBeVisible();

  // + in the tree pane creates a document at the top of the drive, through apps/web, and opens it.
  const created = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/pages',
  );
  await listPane(page).getByRole('button', { name: 'New page', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create new page' });
  await dialog.getByRole('option').filter({ hasText: 'Document' }).first().click();
  await page.getByPlaceholder('Untitled Document').fill('Untitled Document');
  await page.getByRole('dialog', { name: 'Name your page', exact: true }).getByRole('button', { name: 'Create', exact: true }).click();
  const answer = await created;
  expect(answer.ok(), await answer.text()).toBe(true);
  const { id: pageId } = (await answer.json()) as { id: string };
  const address = imagoPath(driveId, `files/${pageId}`);
  await page.waitForURL(pathnameIs(address));
  await expect(treeLink(fileTree(page), 'Untitled Document')).toHaveAttribute('aria-current', 'page');

  // The viewer may edit their own page: the body becomes a textbox, and typing saves it.
  const body = documentBody(page);
  await expect(body).toHaveAttribute('contenteditable', 'true');
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/pages/${pageId}`,
  );
  await body.click();
  await page.keyboard.type('Typed in imago, kept by PageSpace');
  const save = await saved;
  expect(save.ok(), await save.text()).toBe(true);
  await expect(page.locator('[data-slot="object"]').getByText('Saved', { exact: true })).toBeVisible();

  // apps/web stored it…
  const [row] = await db.select({ content: pages.content }).from(pages).where(eq(pages.id, pageId));
  expect(row?.content).toContain('Typed in imago, kept by PageSpace');

  // …and a reload, which keeps nothing of the page, draws it from the server.
  await page.reload();
  await hydrated(page);
  expect(new URL(page.url()).pathname).toBe(address);
  await expect(documentBody(page)).toHaveText('Typed in imago, kept by PageSpace');
  await expect(shell(page)).toHaveAttribute('data-section', 'files');
});

test('a folder opens in the folder browser, and a child folder and page open from it', async ({
  browser,
  baseURL,
}) => {
  // Projects (folder) › Launch (folder) › Brief (document)
  const projects = await factories.createPage(driveId, { type: 'FOLDER', title: 'Projects', content: '' });
  const launch = await factories.createPage(driveId, {
    type: 'FOLDER',
    title: 'Launch',
    content: '',
    parentId: projects.id,
  });
  const brief = await factories.createPage(driveId, {
    type: 'DOCUMENT',
    title: 'Brief',
    content: '<p>The launch brief.</p>',
    parentId: launch.id,
  });

  const page = await openAt(browser, baseURL, imagoPath(driveId, 'files'));
  await tagDocument(page);

  // From the tree, the folder opens as the object: the folder browser, listing its child.
  await treeLink(fileTree(page), 'Projects').click();
  await page.waitForURL(pathnameIs(imagoPath(driveId, `files/${projects.id}`)));
  const projectsView = page.getByRole('region', { name: 'Projects', exact: true });
  const projectsTable = projectsView.getByRole('table', { name: 'Projects contents' });
  await expect(projectsTable.getByRole('row')).toHaveCount(2);
  await expect(projectsTable.getByRole('row', { name: /Launch/ })).toContainText('Folder');

  // Into the child folder: it opens in place, under a path back up.
  await projectsTable.getByRole('link', { name: 'Launch', exact: true }).click();
  await page.waitForURL(pathnameIs(imagoPath(driveId, `files/${launch.id}`)));
  const launchView = page.getByRole('region', { name: 'Launch', exact: true });
  await expect(launchView.getByRole('navigation', { name: 'Folder path' }).getByRole('listitem')).toHaveText([
    'Files',
    '›Projects',
    '›Launch',
  ]);
  const launchTable = launchView.getByRole('table', { name: 'Launch contents' });
  await expect(launchTable.getByRole('link')).toHaveText(['Brief']);

  // A page in it opens as its object.
  await launchTable.getByRole('link', { name: 'Brief', exact: true }).click();
  await page.waitForURL(pathnameIs(imagoPath(driveId, `files/${brief.id}`)));
  await expect(documentBody(page)).toHaveText('The launch brief.');

  expect(await probeOf(page), 'the page reloaded between folders').toBe('same document');
});

test('the tree filter keeps the folders above each match, and only those', async ({ browser, baseURL }) => {
  // Alpha (folder) › Beta (folder) › Needle notes (document)
  //                › Gamma (document)
  // Unrelated (document)
  const alpha = await factories.createPage(driveId, { type: 'FOLDER', title: 'Alpha', content: '', position: 1 });
  const beta = await factories.createPage(driveId, {
    type: 'FOLDER',
    title: 'Beta',
    content: '',
    parentId: alpha.id,
    position: 1,
  });
  await factories.createPage(driveId, { title: 'Needle notes', parentId: beta.id });
  await factories.createPage(driveId, { title: 'Gamma', parentId: alpha.id, position: 2 });
  await factories.createPage(driveId, { title: 'Unrelated', position: 2 });

  const page = await openAt(browser, baseURL, imagoPath(driveId, 'files'));
  const tree = fileTree(page);
  await expect(treeLink(tree, 'Unrelated')).toBeVisible();
  // Collapsed, as the tree opens: nothing under Alpha shows.
  await expect(treeLink(tree, 'Needle notes')).toHaveCount(0);

  const filter = listPane(page).getByLabel('Filter files');
  await filter.fill('needle');

  // The match, with each folder above it opened on the way, and nothing beside them.
  await expect(treeLink(tree, 'Needle notes')).toBeVisible();
  await expect(treeLink(tree, 'Beta')).toBeVisible();
  await expect(tree.getByRole('link')).toHaveCount(3);
  await expect(treeLink(tree, 'Alpha')).toBeVisible();
  await expect(treeLink(tree, 'Gamma')).toHaveCount(0);
  await expect(treeLink(tree, 'Unrelated')).toHaveCount(0);

  // Control: clearing the filter brings the rest back, so the filter is what hid them.
  await filter.fill('');
  await expect(treeLink(tree, 'Unrelated')).toBeVisible();
});
