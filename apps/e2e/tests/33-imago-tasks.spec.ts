import { test, expect, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { taskItems } from '@pagespace/db/schema/tasks';
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
 * # Tasks in imago, end to end (IMG-9.6)
 *
 * A user signed in through the real magic-link route, in a browser of their own, against real
 * web, realtime and imago servers and a real database: adding a task and ticking it in the Table
 * view, moving one across the Kanban board, setting a due date in a task's detail, and being refused
 * the completion of a parent whose subtask is still open. Every write goes through imago's API
 * client to apps/web's task routes; every task under test is created by the click that adds it.
 * Only the list itself is seeded, so each test starts on it.
 *
 * ## Requires
 *
 * The topology of 32-imago-files.spec.ts (the CI `e2e` job): imago's production build behind
 * the e2e proxy at /imago (`E2E_IMAGO_TARGET`), so the shipped CSP is the one under test, and
 * web pointed at the mock server's S3 stand-in (`AWS_ENDPOINT_URL_S3`), because a task is a page
 * and creating one writes its first version to storage.
 *
 * ## Persistence
 *
 * Each change is read back twice: from the database, which is what apps/web stored, and from a
 * reload, which keeps nothing of the page, so what it draws came from the server.
 *
 * ## Waits
 *
 * No sleeps. Each step waits for what it caused: the POST or PATCH answer it sent, then the
 * state the view draws once the list is revalidated from the server.
 */

const LIST = 'Launch plan';

let user: ImagoUser;
let driveId: string;
let listPageId: string;
const contexts: BrowserContext[] = [];

test.beforeEach(async () => {
  user = await imagoUser(`Tasks ${Math.random().toString(36).slice(2, 8)}`);
  driveId = user.homeDriveId;
  const list = await factories.createPage(driveId, { type: 'TASK_LIST', title: LIST, content: '' });
  listPageId = list.id;
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
  // Exercise the retained wide table here; spec 36 covers the compact pane controls.
  await page.setViewportSize({ width: 2400, height: 1000 });
  await signIn(page, user, path);
  await hydrated(page);
  return page;
};

const reload = async (page: Page): Promise<void> => {
  await page.reload();
  await hydrated(page);
};

type TaskCreated = { readonly id: string; readonly pageId: string };

const pathOf = (response: Response) => new URL(response.url()).pathname;

/** The answer to a write of `method` to `path`, once it comes. */
const answerTo = (page: Page, method: string, path: string) =>
  page.waitForResponse((response) => response.request().method() === method && pathOf(response) === path);

const expectOk = async (answer: Response): Promise<void> => {
  expect(answer.ok(), `${answer.request().method()} ${pathOf(answer)}: ${await answer.text()}`).toBe(true);
};

const tasksPath = (pageId: string) => `/api/pages/${pageId}/tasks`;
const taskPath = (pageId: string, taskId: string) => `/api/pages/${pageId}/tasks/${taskId}`;

const treeOf = (page: Page) => page.locator('[data-slot="object"]');
const checkbox = (scope: Page | Locator, title: string) =>
  scope.getByRole('checkbox', { name: new RegExp(`^(Complete|Reopen) ${title}$`) }).filter({ visible: true });

/**
 * Adds a task with the "Add task" (or "Add subtask") control under `scope`, which writes it to
 * the list on `listPage`, and closes the field again. Resolves with what apps/web created.
 */
const addTask = async (
  page: Page,
  scope: Locator,
  { label, listPage, title }: { label: string; listPage: string; title: string },
): Promise<TaskCreated> => {
  const created = answerTo(page, 'POST', tasksPath(listPage));
  const rootTask = label === 'Add task';
  await scope.getByRole('button', { name: rootTask ? 'New Task' : label, exact: true }).click();
  const field = rootTask
    ? scope.locator('input[placeholder="+ Add a new task..."]:visible')
    : scope.getByRole('textbox', { name: label, exact: true });
  await field.fill(title);
  await field.press('Enter');
  const answer = await created;
  await expectOk(answer);
  await field.press('Escape');
  const task = (await answer.json()) as TaskCreated;
  // The pending row is swapped for the server's once the list is read back.
  await expect(scope.locator(rootTask ? `[data-task-id="${task.id}"]:visible` : `[data-task="${task.id}"]`)).toBeVisible();
  return task;
};

const storedTask = async (taskId: string) => {
  const [row] = await db
    .select({ title: pages.title, status: taskItems.status, completedAt: taskItems.completedAt, dueDate: taskItems.dueDate })
    .from(taskItems)
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(eq(taskItems.id, taskId));
  return row;
};

/**
 * A request from inside the signed-in page, as imago's client sends it: the session cookie and
 * web's CSRF token. (Playwright's request context would not carry the Secure session cookie over
 * http://127.0.0.1.) It goes around imago's SWR cache, so the open view does not see it.
 */
const fetchInPage = (page: Page, method: string, path: string, json: Record<string, unknown>) =>
  page.evaluate(
    async ({ method, path, json }) => {
      const csrf = (await (await fetch('/api/auth/csrf', { credentials: 'same-origin' })).json()) as {
        csrfToken: string;
      };
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
        body: JSON.stringify(json),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    { method, path, json },
  );

test('a task added in the Table view, then ticked, stays added and done across reloads', async ({
  browser,
  baseURL,
}) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, 'tasks'));

  // The list pane opens the list as the object, in the Table view a new viewer starts in.
  await page.locator('[data-slot="list"]').getByRole('link', { name: new RegExp(`^${LIST}\\b`) }).click();
  await page.waitForURL(pathnameIs(imagoPath(driveId, `tasks/${listPageId}`)));
  await expect(page.getByRole('button', { name: 'Table view', exact: true })).toBeVisible();
  await treeOf(page).getByRole('button', { name: 'All', exact: true }).click();

  const tree = treeOf(page);
  const task = await addTask(page, tree, { label: 'Add task', listPage: listPageId, title: 'Write the brief' });
  expect(await storedTask(task.id)).toMatchObject({ title: 'Write the brief', status: 'pending', completedAt: null });

  await reload(page);
  await expect(checkbox(treeOf(page), 'Write the brief')).toHaveAttribute('aria-checked', 'false');

  // Ticking it is a PATCH to its done status; the server stamps completedAt.
  const ticked = answerTo(page, 'PATCH', taskPath(listPageId, task.id));
  await checkbox(treeOf(page), 'Write the brief').click();
  await expectOk(await ticked);
  await expect(checkbox(treeOf(page), 'Write the brief')).toHaveAttribute('aria-checked', 'true');
  const done = await storedTask(task.id);
  expect(done?.status).toBe('completed');
  expect(done?.completedAt).not.toBeNull();

  await reload(page);
  await expect(checkbox(treeOf(page), 'Write the brief')).toHaveAttribute('aria-checked', 'true');
});

const boardOf = (page: Page) => page.getByRole('group', { name: 'Task board', exact: true });
const column = (page: Page, name: string) => boardOf(page).getByRole('region', { name, exact: true });
const card = (scope: Locator, title: string) => scope.getByRole('article', { name: title, exact: true });

test('a task moved with the status selector stays in its Kanban column across a reload', async ({
  browser,
  baseURL,
}) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, `tasks/${listPageId}`));
  const task = await addTask(page, treeOf(page), { label: 'Add task', listPage: listPageId, title: 'Draft the post' });
  await addTask(page, treeOf(page), { label: 'Add task', listPage: listPageId, title: 'Pick a date' });

  await page.getByRole('button', { name: 'Kanban view', exact: true }).click();
  await expect(card(column(page, 'To Do'), 'Draft the post')).toBeVisible();
  await expect(column(page, 'To Do').getByRole('heading')).toHaveAccessibleName('To Do, 2 tasks');

  await page.getByRole('button', { name: 'Table view', exact: true }).click();
  const moved = answerTo(page, 'PATCH', taskPath(listPageId, task.id));
  await treeOf(page).getByRole('combobox', { name: 'Status of Draft the post', exact: true }).click();
  await page.getByRole('option', { name: 'In Progress', exact: true }).click();
  await expectOk(await moved);
  await page.getByRole('button', { name: 'Kanban view', exact: true }).click();
  await expect(card(column(page, 'In Progress'), 'Draft the post')).toBeVisible();
  await expect(column(page, 'In Progress').getByRole('heading')).toHaveAccessibleName('In Progress, 1 task');
  await expect(column(page, 'To Do').getByRole('heading')).toHaveAccessibleName('To Do, 1 task');
  expect((await storedTask(task.id))?.status).toBe('in_progress');

  // The Board is this viewer's saved view, so the reload opens on it, drawn from the server.
  await reload(page);
  await expect(card(column(page, 'In Progress'), 'Draft the post')).toBeVisible();
  await expect(card(column(page, 'To Do'), 'Pick a date')).toBeVisible();
  await expect(column(page, 'In Progress').getByRole('heading')).toHaveAccessibleName('In Progress, 1 task');
});

test('a card dragged to another column on the Board stays there across a reload', async ({ browser, baseURL }) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, `tasks/${listPageId}`));
  const task = await addTask(page, treeOf(page), { label: 'Add task', listPage: listPageId, title: 'Order banners' });
  await page.getByRole('button', { name: 'Kanban view', exact: true }).click();

  const handle = page.getByRole('button', { name: 'Drag Order banners', exact: true });
  const from = await handle.boundingBox();
  const held = await card(column(page, 'To Do'), 'Order banners').boundingBox();
  const to = await column(page, 'Blocked').boundingBox();
  if (from === null || held === null || to === null) throw new Error('the card or the Blocked column is not on screen');

  // A real pointer drag: press on the handle, travel past the 4px activation distance, then on in
  // steps so each move is a pointermove the sensor sees, and let go. The board picks the column
  // the closest corners of the dragged card and column, and the
  // handle is at the card's left edge: so the pointer travels as far as takes the card's centre
  // to the column's.
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = {
    x: start.x + (to.x + to.width / 2) - (held.x + held.width / 2),
    y: start.y + (to.y + held.height) - held.y,
  };
  const moved = answerTo(page, 'PATCH', taskPath(listPageId, task.id));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y, { steps: 4 });
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  await expectOk(await moved);
  await expect(card(column(page, 'Blocked'), 'Order banners')).toBeVisible();
  expect((await storedTask(task.id))?.status).toBe('blocked');

  await reload(page);
  await expect(card(column(page, 'Blocked'), 'Order banners')).toBeVisible();
  await expect(column(page, 'To Do').getByRole('heading')).toHaveAccessibleName('To Do, 0 tasks');
});

test('a due date set in the task’s detail stays set across a reload', async ({ browser, baseURL }) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, `tasks/${listPageId}`));
  const task = await addTask(page, treeOf(page), { label: 'Add task', listPage: listPageId, title: 'Book the venue' });

  // The title opens the task's detail in the object pane.
  await treeOf(page).getByRole('button', { name: 'Book the venue', exact: true }).click();
  await page.waitForURL(pathnameIs(imagoPath(driveId, `tasks/${task.pageId}`)));
  const detail = page.getByRole('article', { name: 'Book the venue', exact: true });
  // A date field has no ARIA role of its own; its label names it.
  const due = detail.getByLabel('Due date', { exact: true });
  await expect(due).toHaveValue('');

  const saved = answerTo(page, 'PATCH', taskPath(listPageId, task.id));
  await due.fill('2026-11-14');
  await expectOk(await saved);

  // Stored as that day's midnight in the viewer's own zone, as classic stores it.
  const midnight = await page.evaluate(() => new Date(2026, 10, 14).toISOString());
  expect((await storedTask(task.id))?.dueDate?.toISOString()).toBe(midnight);

  await reload(page);
  await expect(
    page.getByRole('article', { name: 'Book the venue', exact: true }).getByLabel('Due date', { exact: true }),
  ).toHaveValue('2026-11-14');
});

test('a parent with an open subtask is refused completion, by the view and by the server', async ({
  browser,
  baseURL,
}) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, `tasks/${listPageId}`));
  const parent = await addTask(page, treeOf(page), { label: 'Add task', listPage: listPageId, title: 'Ship it' });
  const stale = await addTask(page, treeOf(page), { label: 'Add task', listPage: listPageId, title: 'Print it' });

  // Refused by the server: a subtask lands under "Print it" from outside this view, so the view
  // still counts none and sends the completion. apps/web answers 422 and the tick rolls back.
  const outside = await fetchInPage(page, 'POST', tasksPath(stale.pageId), { title: 'Proof the cover' });
  expect(outside.status).toBe(201);
  const refused = answerTo(page, 'PATCH', taskPath(listPageId, stale.id));
  await checkbox(treeOf(page), 'Print it').click();
  const refusal = await refused;
  expect(refusal.status()).toBe(422);
  expect(await refusal.json()).toMatchObject({ code: 'SUBTASKS_INCOMPLETE', pending: 1, total: 1 });
  await expect(page.getByText('Complete all sub-tasks first (1 of 1 remaining)', { exact: true })).toBeVisible();
  await expect(checkbox(treeOf(page), 'Print it')).toHaveAttribute('aria-checked', 'false');
  expect(await storedTask(stale.id)).toMatchObject({ status: 'pending', completedAt: null });

  // Refused by the view: a subtask added in the detail is one the view counts, so ticking the
  // parent says why at once and sends nothing.
  await treeOf(page).getByRole('button', { name: 'Ship it', exact: true }).click();
  await page.waitForURL(pathnameIs(imagoPath(driveId, `tasks/${parent.pageId}`)));
  const detail = page.getByRole('article', { name: 'Ship it', exact: true });
  const subtasks = detail.getByRole('region', { name: 'Subtasks', exact: true });
  const child = await addTask(page, subtasks, { label: 'Add subtask', listPage: parent.pageId, title: 'Tag the release' });
  await expect(subtasks.getByRole('heading')).toHaveText('Subtasks · 0 of 1');

  const completions: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname === taskPath(listPageId, parent.id)) {
      completions.push(request.url());
    }
  });
  await checkbox(detail, 'Ship it').click();
  await expect(detail.getByRole('status')).toHaveText('Complete all sub-tasks first (1 of 1 remaining)');
  await expect(checkbox(detail, 'Ship it')).toHaveAttribute('aria-checked', 'false');
  expect(completions, 'the view sent a completion it should have refused').toEqual([]);

  // Still open after a reload: nothing was stored.
  await reload(page);
  const reloaded = page.getByRole('article', { name: 'Ship it', exact: true });
  await expect(checkbox(reloaded, 'Ship it')).toHaveAttribute('aria-checked', 'false');
  expect(await storedTask(parent.id)).toMatchObject({ status: 'pending', completedAt: null });

  // Control: once the subtask is done, the same tick completes the parent, so the open subtask
  // is what refused it.
  const childDone = answerTo(page, 'PATCH', taskPath(parent.pageId, child.id));
  await checkbox(reloaded, 'Tag the release').click();
  await expectOk(await childDone);
  await expect(reloaded.getByRole('region', { name: 'Subtasks' }).getByRole('heading')).toHaveText('Subtasks · 1 of 1');
  const parentDone = answerTo(page, 'PATCH', taskPath(listPageId, parent.id));
  await checkbox(reloaded, 'Ship it').click();
  await expectOk(await parentDone);
  await expect(checkbox(reloaded, 'Ship it')).toHaveAttribute('aria-checked', 'true');
  expect((await storedTask(parent.id))?.completedAt).not.toBeNull();
});
