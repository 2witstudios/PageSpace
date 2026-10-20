import { test, expect, type BrowserContext, type Locator, type Page, type Response } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { taskItems, taskLists, taskStatusConfigs } from '@pagespace/db/schema/tasks';
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
 * web, realtime and imago servers and a real database, working a task list in imago's native
 * view (ui/tasks/task-list-view): adding a task and ticking it in the Tree, moving one across
 * the Board by its "Move to…" menu and by a keyboard drag, setting a column's WIP limit,
 * scheduling a task onto the Roadmap, setting a due date in a task's detail, and being refused
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
 * reload, which keeps nothing of the page but this viewer's chosen view (localStorage), so what
 * it draws came from the server.
 *
 * ## Waits
 *
 * No sleeps. Each step waits for what it caused: the POST, PATCH or PUT answer it sent, then the
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
  // Wide enough for the Board's four columns side by side; spec 36 covers the Files route.
  await page.setViewportSize({ width: 1800, height: 1000 });
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
const statusesPath = (pageId: string) => `/api/pages/${pageId}/tasks/statuses`;

const objectOf = (page: Page) => page.locator('[data-slot="object"]');
const strip = (page: Page) => objectOf(page).getByRole('toolbar', { name: 'List controls', exact: true });
/** One of the strip's Focus | Tree | Board | Roadmap radios. */
const viewRadio = (page: Page, name: 'Focus' | 'Tree' | 'Board' | 'Roadmap') =>
  strip(page).getByRole('radiogroup', { name: 'View', exact: true }).getByRole('radio', { name, exact: true });
const showView = async (page: Page, name: 'Focus' | 'Tree' | 'Board' | 'Roadmap'): Promise<void> => {
  await viewRadio(page, name).click();
  await expect(viewRadio(page, name)).toHaveAttribute('aria-checked', 'true');
};

/** A task's tick: "Complete <title>" in a Tree row, "Mark <title> complete" on the task's own detail. */
const checkbox = (scope: Page | Locator, title: string) =>
  scope.getByRole('checkbox', { name: new RegExp(`^(?:Complete ${title}|Mark ${title} complete)$`) });

/**
 * Adds a task with the InlineAdd under `scope` ("Add task" at the end of the Tree, "Add subtask"
 * in a detail's Subtasks), which writes it to the list on `listPage`, and closes the field again.
 * Resolves with what apps/web created.
 */
const addTask = async (
  page: Page,
  scope: Locator,
  { label, listPage, title }: { label: 'Add task' | 'Add subtask'; listPage: string; title: string },
): Promise<TaskCreated> => {
  const created = answerTo(page, 'POST', tasksPath(listPage));
  await scope.getByRole('button', { name: label, exact: true }).click();
  const field = scope.getByRole('textbox', { name: label, exact: true });
  await field.fill(title);
  await field.press('Enter');
  const answer = await created;
  await expectOk(answer);
  await field.press('Escape');
  const task = (await answer.json()) as TaskCreated;
  // The pending row is swapped for the server's once the list is read back.
  await expect(scope.locator(`[data-task="${task.id}"]`)).toBeVisible();
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

/** The WIP limit stored on one of the list's statuses. */
const storedWipLimit = async (slug: string) => {
  const [row] = await db
    .select({ wipLimit: taskStatusConfigs.wipLimit })
    .from(taskStatusConfigs)
    .innerJoin(taskLists, eq(taskLists.id, taskStatusConfigs.taskListId))
    .where(and(eq(taskLists.pageId, listPageId), eq(taskStatusConfigs.slug, slug)));
  return row?.wipLimit;
};

/**
 * A request from inside the signed-in page, as imago's client sends it: the session cookie and
 * web's CSRF token. (Playwright's request context would not carry the Secure session cookie over
 * http://127.0.0.1.) It goes around Imago's SWR cache; socket events may still refresh the open view.
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

test('a task added in the Tree view, then ticked, stays added and done across reloads', async ({
  browser,
  baseURL,
}) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, 'tasks'));

  // The list pane opens the list as the object, in the Tree view a new viewer starts in.
  await page.locator('[data-slot="list"]').getByRole('link', { name: new RegExp(`^${LIST}\\b`) }).click();
  await page.waitForURL(pathnameIs(imagoPath(driveId, `tasks/${listPageId}`)));
  await expect(viewRadio(page, 'Tree')).toHaveAttribute('aria-checked', 'true');

  const tree = objectOf(page);
  const task = await addTask(page, tree, { label: 'Add task', listPage: listPageId, title: 'Write the brief' });
  expect(await storedTask(task.id)).toMatchObject({ title: 'Write the brief', status: 'pending', completedAt: null });

  await reload(page);
  await expect(checkbox(objectOf(page), 'Write the brief')).toHaveAttribute('aria-checked', 'false');

  // Ticking it is a PATCH to its done status; the server stamps completedAt.
  const ticked = answerTo(page, 'PATCH', taskPath(listPageId, task.id));
  await checkbox(objectOf(page), 'Write the brief').click();
  await expectOk(await ticked);
  await expect(checkbox(objectOf(page), 'Write the brief')).toHaveAttribute('aria-checked', 'true');
  const done = await storedTask(task.id);
  expect(done?.status).toBe('completed');
  expect(done?.completedAt).not.toBeNull();

  // The Tree keeps done tasks in place, ticked.
  await reload(page);
  await expect(checkbox(objectOf(page), 'Write the brief')).toHaveAttribute('aria-checked', 'true');
});

const boardOf = (page: Page) => page.getByRole('group', { name: `${LIST} board`, exact: true });
const column = (page: Page, name: string) => boardOf(page).getByRole('region', { name, exact: true });
const card = (scope: Locator, title: string) => scope.getByRole('article', { name: title, exact: true });

test('a task moved with its Move to… menu stays in its Board column across a reload', async ({
  browser,
  baseURL,
}) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, `tasks/${listPageId}`));
  const task = await addTask(page, objectOf(page), { label: 'Add task', listPage: listPageId, title: 'Draft the post' });
  await addTask(page, objectOf(page), { label: 'Add task', listPage: listPageId, title: 'Pick a date' });

  await showView(page, 'Board');
  await expect(card(column(page, 'To Do'), 'Draft the post')).toBeVisible();
  await expect(column(page, 'To Do').getByRole('heading')).toHaveAccessibleName('To Do, 2 tasks');

  // "Move to…" lists the other statuses; choosing one is a PATCH of the task's status.
  const moved = answerTo(page, 'PATCH', taskPath(listPageId, task.id));
  await card(column(page, 'To Do'), 'Draft the post').getByRole('button', { name: 'Move Draft the post to…', exact: true }).click();
  await boardOf(page)
    .getByRole('menu', { name: 'Move Draft the post to', exact: true })
    .getByRole('menuitem', { name: 'In Progress', exact: true })
    .click();
  await expectOk(await moved);
  await expect(card(column(page, 'In Progress'), 'Draft the post')).toBeVisible();
  await expect(column(page, 'In Progress').getByRole('heading')).toHaveAccessibleName('In Progress, 1 task');
  await expect(column(page, 'To Do').getByRole('heading')).toHaveAccessibleName('To Do, 1 task');
  expect((await storedTask(task.id))?.status).toBe('in_progress');

  // The Board is this viewer's saved view, so the reload opens on it, drawn from the server.
  await reload(page);
  await expect(viewRadio(page, 'Board')).toHaveAttribute('aria-checked', 'true');
  await expect(card(column(page, 'In Progress'), 'Draft the post')).toBeVisible();
  await expect(card(column(page, 'To Do'), 'Pick a date')).toBeVisible();
  await expect(column(page, 'In Progress').getByRole('heading')).toHaveAccessibleName('In Progress, 1 task');
});

test('a card dragged to another column on the Board stays there across a reload', async ({ browser, baseURL }) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, `tasks/${listPageId}`));
  const task = await addTask(page, objectOf(page), { label: 'Add task', listPage: listPageId, title: 'Order banners' });
  await showView(page, 'Board');
  await expect(card(column(page, 'To Do'), 'Order banners')).toBeVisible();

  // A keyboard drag (@dnd-kit's KeyboardSensor): Space picks the card up by its handle, each
  // ArrowRight carries it a whole column along its lane, Space drops it. Each step waits for
  // the drag's own live-region announcement, so no key outruns the board. The live region
  // holds only the latest line, and picking up is at once replaced by where the card is
  // over, so the pickup is read from that. The sensor starts listening for keys a moment
  // after it picks the card up, so a key that lands before then changes nothing: a step
  // presses again only while the announcement has not moved at all.
  const handle = card(column(page, 'To Do'), 'Order banners').getByRole('button', { name: 'Drag Order banners', exact: true });
  const live = page.locator('[id^="DndLiveRegion"]');
  const announced = (text: string) => expect(live).toHaveText(text);
  const step = async (key: string, from: string, to: string) => {
    for (let tries = 0; tries < 5; tries += 1) {
      await page.keyboard.press(key);
      try {
        await expect(live).not.toHaveText(from, { timeout: 1000 });
        break;
      } catch {
        // The key was not heard yet: press it again.
      }
    }
    await announced(to);
  };
  const moved = answerTo(page, 'PATCH', taskPath(listPageId, task.id));
  await handle.focus();
  await page.keyboard.press('Space');
  await announced('Order banners is over To Do.');
  await step('ArrowRight', 'Order banners is over To Do.', 'Order banners is over In Progress.');
  await step('ArrowRight', 'Order banners is over In Progress.', 'Order banners is over Blocked.');
  await page.keyboard.press('Space');
  await expectOk(await moved);
  await expect(card(column(page, 'Blocked'), 'Order banners')).toBeVisible();
  expect((await storedTask(task.id))?.status).toBe('blocked');

  await reload(page);
  await expect(card(column(page, 'Blocked'), 'Order banners')).toBeVisible();
  await expect(column(page, 'To Do').getByRole('heading')).toHaveAccessibleName('To Do, 0 tasks');
});

test('a WIP limit set from a Board column’s menu stays set across a reload', async ({ browser, baseURL }) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, `tasks/${listPageId}`));
  await showView(page, 'Board');
  const inProgress = column(page, 'In Progress');
  await expect(inProgress.getByRole('heading')).toHaveAccessibleName('In Progress, 0 tasks');

  // Set WIP limit… swaps the item for a number field; Enter saves every status back (PUT).
  await inProgress.getByRole('button', { name: 'In Progress column actions', exact: true }).click();
  const menu = inProgress.getByRole('menu', { name: 'In Progress column', exact: true });
  await menu.getByRole('menuitem', { name: 'Set WIP limit…', exact: true }).click();
  const limit = menu.getByRole('spinbutton', { name: 'WIP limit for In Progress', exact: true });
  await limit.fill('2');
  const saved = answerTo(page, 'PUT', statusesPath(listPageId));
  await limit.press('Enter');
  await expectOk(await saved);
  await expect(inProgress.getByRole('heading')).toHaveAccessibleName('In Progress, 0 tasks, limit 2');
  expect(await storedWipLimit('in_progress')).toBe(2);
  // The other columns keep no limit: the PUT sent each row back whole.
  expect(await storedWipLimit('pending')).toBeNull();

  await reload(page);
  await expect(column(page, 'In Progress').getByRole('heading')).toHaveAccessibleName('In Progress, 0 tasks, limit 2');
  await expect(column(page, 'To Do').getByRole('heading')).toHaveAccessibleName('To Do, 0 tasks');
});

test('a task scheduled on the Roadmap draws as a bar, and still does after a reload', async ({ browser, baseURL }) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, `tasks/${listPageId}`));
  const task = await addTask(page, objectOf(page), { label: 'Add task', listPage: listPageId, title: 'Plan the launch' });

  await showView(page, 'Roadmap');
  const timeline = page.getByRole('group', { name: `${LIST} roadmap`, exact: true });
  const bar = timeline.getByRole('group', { name: /^Plan the launch, / });
  // Undated, it waits in the Unscheduled tray; Schedule gives it a due date a week out.
  await expect(bar).toHaveCount(0);
  const saved = answerTo(page, 'PATCH', taskPath(listPageId, task.id));
  await page
    .getByRole('region', { name: 'Unscheduled', exact: true })
    .getByRole('button', { name: 'Schedule Plan the launch', exact: true })
    .click();
  await expectOk(await saved);
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAccessibleName(/^Plan the launch, .+ to .+, To Do$/);
  const weekOut = await page.evaluate(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();
  });
  expect((await storedTask(task.id))?.dueDate?.toISOString()).toBe(weekOut);

  await reload(page);
  await expect(viewRadio(page, 'Roadmap')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('group', { name: `${LIST} roadmap`, exact: true }).getByRole('group', { name: /^Plan the launch, / })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Unscheduled', exact: true })).toHaveCount(0);
});

test('a due date set in the task’s detail stays set across a reload', async ({ browser, baseURL }) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, `tasks/${listPageId}`));
  const task = await addTask(page, objectOf(page), { label: 'Add task', listPage: listPageId, title: 'Book the venue' });

  // The title opens the task's detail in the object pane.
  await objectOf(page).getByRole('link', { name: 'Book the venue', exact: true }).click();
  await page.waitForURL(pathnameIs(imagoPath(driveId, `tasks/${task.pageId}`)));
  const fields = page.getByRole('article', { name: 'Book the venue', exact: true }).getByRole('group', { name: 'Fields', exact: true });
  await fields.getByRole('button', { name: 'Set due date', exact: true }).click();

  // A quick pick saves and closes the picker.
  const saved = answerTo(page, 'PATCH', taskPath(listPageId, task.id));
  await page.getByRole('dialog', { name: 'Due date', exact: true }).getByRole('button', { name: /^Next week/ }).click();
  await expectOk(await saved);

  // Stored as that day's midnight in the viewer's own zone, as classic stores it.
  const { midnight, dayName } = await page.evaluate(() => {
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
    return {
      midnight: day.toISOString(),
      dayName: day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    };
  });
  expect((await storedTask(task.id))?.dueDate?.toISOString()).toBe(midnight);
  await expect(fields.getByRole('button', { name: /^Due · / })).toBeVisible();

  await reload(page);
  const reloaded = page.getByRole('article', { name: 'Book the venue', exact: true }).getByRole('group', { name: 'Fields', exact: true });
  await expect(reloaded.getByRole('button', { name: 'Set due date', exact: true })).toHaveCount(0);
  // The picker opens on the stored day, selected.
  await reloaded.getByRole('button', { name: /^Due · / }).click();
  const picker = page.getByRole('dialog', { name: 'Due date', exact: true });
  await expect(picker.getByRole('gridcell', { selected: true }).getByRole('button')).toHaveAccessibleName(dayName);
});

test('a parent with an open subtask is refused completion, by the view and by the server', async ({
  browser,
  baseURL,
}) => {
  const page = await openAt(browser, baseURL, imagoPath(driveId, `tasks/${listPageId}`));
  const parent = await addTask(page, objectOf(page), { label: 'Add task', listPage: listPageId, title: 'Ship it' });
  const stale = await addTask(page, objectOf(page), { label: 'Add task', listPage: listPageId, title: 'Print it' });

  // Refused by the server: hold root-list revalidation to reproduce a genuinely stale client
  // while the outside write and completion still reach the real server. Socket refresh normally
  // updates the subtask count and correctly refuses completion before a PATCH.
  let releaseRefresh: () => void = () => {};
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const rootTasks = (url: URL) => url.pathname === tasksPath(listPageId);
  await page.route(rootTasks, async (route) => {
    if (route.request().method() === 'GET') await refreshGate;
    await route.continue();
  });
  try {
    const outside = await fetchInPage(page, 'POST', tasksPath(stale.pageId), { title: 'Proof the cover' });
    expect(outside.status).toBe(201);
    const refused = answerTo(page, 'PATCH', taskPath(listPageId, stale.id));
    await checkbox(objectOf(page), 'Print it').click();
    const refusal = await refused;
    expect(refusal.status()).toBe(422);
    expect(await refusal.json()).toMatchObject({ code: 'SUBTASKS_INCOMPLETE', pending: 1, total: 1 });
    // The optimistic tick is rolled back at once.
    await expect(checkbox(objectOf(page), 'Print it')).toHaveAttribute('aria-checked', 'false');
    expect(await storedTask(stale.id)).toMatchObject({ status: 'pending', completedAt: null });
    // The view says why once the list it re-reads after a refusal comes back.
    releaseRefresh();
    const row = objectOf(page).locator(`[data-task="${stale.id}"]`);
    await expect(row.getByRole('status')).toHaveText('Complete all sub-tasks first (1 of 1 remaining)');
    await expect(checkbox(objectOf(page), 'Print it')).toHaveAttribute('aria-checked', 'false');
  } finally {
    releaseRefresh();
    // Wait for held handlers to finish; removing them immediately can also
    // continue the same request while its handler is resuming.
    await page.unrouteAll({ behavior: 'wait' });
  }

  // Refused by the view: a subtask added in the detail is one the view counts, so ticking the
  // parent says why at once and sends nothing.
  await objectOf(page).getByRole('link', { name: 'Ship it', exact: true }).click();
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
  await expect(
    detail.getByRole('status').filter({ hasText: 'Complete all sub-tasks first' }),
  ).toHaveText('Complete all sub-tasks first (1 of 1 remaining)');
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
