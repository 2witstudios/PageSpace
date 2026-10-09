import { selectTaskFilter } from '../fixtures/retained-tasks.fixture';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { channelMessages, channelReadStatus } from '@pagespace/db/schema/chat';
import { conversations } from '@pagespace/db/schema/conversations';
import { directMessages, dmConversations } from '@pagespace/db/schema/social';
import { deleteUsers, imagoPath, type ImagoUser } from '../fixtures/imago.fixture';
import {
  at,
  filesReady,
  openSignedIn,
  pinConversation,
  seedFiles,
  settle,
  switchTheme,
  teamDrive,
  THEMES,
  visualBrowser,
  visualUser,
} from '../fixtures/imago-visual.fixture';
import { resetMock } from '../support/http';

/**
 * # Imago's visual baselines (IMG-10.4)
 *
 * Each finished surface — chat, the files browser, a document, a channel, a DM, a task list
 * and its Board — is compared against a committed screenshot at 1400×800, in dark and in light.
 * A change to a design token (apps/imago/src/app/globals.css) or to anything else that moves a
 * pixel fails here until the baselines are regenerated on purpose; 35-imago-visual-control.spec.ts
 * proves that with one token changed.
 *
 * ## Requires
 *
 * The topology of 32-imago-files.spec.ts (the CI `e2e` job): imago's production build behind
 * the e2e proxy at /imago, web on the mock model and the mock S3.
 *
 * ## Baselines are Linux's
 *
 * Fonts rasterise differently on macOS and Linux, so the committed PNGs
 * (tests/__screenshots__/*-chromium-linux.png) are made on the CI runner itself: dispatch the
 * Test Suite workflow on the branch with `update_visual_baselines` ticked, download the
 * `imago-visual-baselines` artifact, review the images and commit them. CI never writes a
 * baseline in a normal run, and nothing in CI commits one. A local run on macOS compares against
 * its own `-darwin` files, which are git-ignored.
 *
 * ## Determinism
 *
 * The frame, theme, motion and clock are pinned by fixtures/imago-visual.fixture.ts. The data
 * is fixed: names, titles, bodies and positions are constants, and every timestamp the frame
 * can show is a fixed moment of the pinned day. Files and messages are seeded straight into the
 * database. Tasks go through apps/web's task route (a task is a page with a first version in
 * storage) with fixed fields and due dates; nothing on their surfaces shows when they were made.
 * The chat is a real send to the mock model, whose reply is fixed, with its timestamps then
 * pinned. Each test waits for the content it expects before comparing.
 */

// Two sign-ins' worth of compiles on a cold server, a send, and two compares per test.
test.setTimeout(120_000);

const LOAD_MS = 30_000;

const contexts: BrowserContext[] = [];
let created: string[] = [];

test.beforeEach(async ({ request }) => {
  await resetMock(request);
  created = [];
});

// In teardown, not inline, so a failing comparison never leaks a browser or a row.
test.afterEach(async ({ request }) => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await resetMock(request);
  await deleteUsers(created);
});

const person = async (name: string): Promise<ImagoUser> => {
  const user = await visualUser(name);
  created.push(user.id);
  return user;
};

/** Signed in as `user` on `path`, dark first; `compare` then shoots both themes. */
const open = async (
  browser: Parameters<typeof visualBrowser>[0],
  baseURL: string | undefined,
  user: ImagoUser,
  path: string,
): Promise<Page> => {
  const { context, page } = await visualBrowser(browser, baseURL ?? '', THEMES[0]);
  contexts.push(context);
  await openSignedIn(page, user, path);
  return page;
};

/**
 * Compares the page against `<name>-<theme>.png` in each theme. `ready` waits for the
 * surface's own content after each (re)load, so the comparison never races a fetch.
 */
const compare = async (
  page: Page,
  baseURL: string | undefined,
  name: string,
  ready: (page: Page) => Promise<void>,
): Promise<void> => {
  for (const theme of THEMES) {
    if (theme !== THEMES[0]) await switchTheme(page, baseURL ?? '', theme);
    await settle(page, theme);
    await ready(page);
    await expect(page).toHaveScreenshot(`${name}-${theme}.png`);
  }
};

const listPane = (page: Page) => page.locator('[data-slot="list"]');

test('chat', async ({ browser, baseURL }) => {
  const user = await person('Ada Lovelace');
  const page = await open(browser, baseURL, user, imagoPath(user.homeDriveId));
  const chat = page.getByRole('region', { name: 'Chat', exact: true });
  await expect(listPane(page).getByRole('region', { name: 'Chat history' }).getByRole('status')).toHaveCount(0, {
    timeout: LOAD_MS,
  });

  // One turn through the real path: composer → web → page-chat → the mock model, which answers "pong".
  const composer = chat.getByLabel('Message Imago', { exact: true });
  await composer.fill('What ships in October?');
  await composer.press('Enter');
  await expect(chat.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveText(/pong/, { timeout: LOAD_MS });
  await expect(chat.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, { timeout: LOAD_MS });

  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.userId, user.id), eq(conversations.type, 'page')));
  if (conversation === undefined) throw new Error('the send stored no conversation');
  await pinConversation(conversation.id, [at('14:02'), at('14:03')]);
  await page.reload();

  await compare(page, baseURL, 'chat', async (shown) => {
    const thread = shown.getByRole('region', { name: 'Chat', exact: true });
    await expect(thread.locator('[data-testid="chat-message"][data-role="user"]')).toHaveText(/What ships in October\?/, { timeout: LOAD_MS });
    await expect(thread.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveText(/pong/);
    await expect(
      listPane(shown).getByRole('region', { name: 'Chat history' }).getByRole('button', {
        name: 'What ships in October?',
        exact: true,
      }),
    ).toBeVisible();
  });
});

test('files', async ({ browser, baseURL }) => {
  const user = await person('Ada Lovelace');
  const driveId = await teamDrive(user);
  const { projects } = await seedFiles(driveId);
  const page = await open(browser, baseURL, user, imagoPath(driveId, `files/${projects.id}`));

  await compare(page, baseURL, 'files', filesReady);
});

test('document', async ({ browser, baseURL }) => {
  const user = await person('Ada Lovelace');
  const driveId = await teamDrive(user);
  const { brief } = await seedFiles(driveId);
  const page = await open(browser, baseURL, user, imagoPath(driveId, `files/${brief.id}`));

  await compare(page, baseURL, 'document', async (shown) => {
    await expect(shown.locator('.retained-ui .tiptap').first()).toContainText('Ship the preview to the team first', {
      timeout: LOAD_MS,
    });
    await expect(shown.locator('.retained-ui .tiptap').first()).toHaveAttribute('contenteditable', 'true');
    await expect(shown.locator('[data-slot="object"]').getByText('181 characters', { exact: true })).toBeVisible();
  });
});

test('channel', async ({ browser, baseURL }) => {
  const ada = await person('Ada Lovelace');
  const grace = await person('Grace Hopper');
  const driveId = await teamDrive(ada);
  await factories.createDriveMember(driveId, grace.id, { role: 'MEMBER' });
  const general = await factories.createPage(driveId, {
    type: 'CHANNEL',
    title: 'general',
    content: '',
    isPrivate: false,
    position: 1,
  });
  const design = await factories.createPage(driveId, {
    type: 'CHANNEL',
    title: 'design',
    content: '',
    isPrivate: false,
    position: 2,
  });
  await db.insert(channelMessages).values([
    { pageId: general.id, userId: grace.id, content: 'Morning! The preview build is up.', createdAt: at('09:12') },
    { pageId: general.id, userId: ada.id, content: 'Looks great. Files and tasks feel fast.', createdAt: at('09:20') },
    { pageId: general.id, userId: grace.id, content: 'I will share it with the team after lunch.', createdAt: at('09:21') },
  ]);
  // Read up to now: an unread count would clear when the open channel marks itself read, so
  // whether the badge and the "New" divider showed would depend on when the shot was taken.
  await db.insert(channelReadStatus).values([
    { userId: ada.id, channelId: general.id, lastReadAt: at('09:30') },
    { userId: ada.id, channelId: design.id, lastReadAt: at('09:30') },
  ]);

  const page = await open(browser, baseURL, ada, imagoPath(driveId, `messages/${general.id}`));
  await compare(page, baseURL, 'channel', async (shown) => {
    const thread = shown.getByRole('region', { name: '# general', exact: true });
    await expect(thread.getByRole('article').filter({ hasText: 'after lunch' })).toBeVisible({ timeout: LOAD_MS });
    await expect(thread.getByRole('article').filter({ hasText: 'preview build is up' })).toBeVisible();
  });
});

test('direct message', async ({ browser, baseURL }) => {
  const ada = await person('Ada Lovelace');
  const grace = await person('Grace Hopper');
  const [first, second] = [ada.id, grace.id].sort();
  if (first === undefined || second === undefined) throw new Error('two participants');
  const [conversation] = await db
    .insert(dmConversations)
    .values({
      participant1Id: first,
      participant2Id: second,
      lastMessageAt: at('10:05'),
      lastMessagePreview: 'Perfect, see you then.',
      participant1LastRead: at('10:30'),
      participant2LastRead: at('10:30'),
      createdAt: at('10:00'),
      updatedAt: at('10:05'),
    })
    .returning({ id: dmConversations.id });
  if (conversation === undefined) throw new Error('no DM conversation');
  await db.insert(directMessages).values([
    { conversationId: conversation.id, senderId: grace.id, content: 'Can we review the board at 3?', createdAt: at('10:00'), isRead: true, readAt: at('10:30') },
    { conversationId: conversation.id, senderId: ada.id, content: 'Yes — I will bring the launch brief.', createdAt: at('10:03'), isRead: true, readAt: at('10:30') },
    { conversationId: conversation.id, senderId: grace.id, content: 'Perfect, see you then.', createdAt: at('10:05'), isRead: true, readAt: at('10:30') },
  ]);

  const page = await open(browser, baseURL, ada, `/imago/dm/${conversation.id}`);
  await compare(page, baseURL, 'direct-message', async (shown) => {
    const thread = shown.getByRole('region', { name: 'Grace Hopper', exact: true });
    await expect(thread.getByRole('article').filter({ hasText: 'see you then' })).toBeVisible({ timeout: LOAD_MS });
  });
});

const LIST = 'Launch plan';

/**
 * Tasks are made through apps/web's task route from inside the signed-in page (a task is a page
 * with a first version in storage, which a database insert would skip), with fixed titles,
 * statuses, priorities, due dates and an assignee.
 */
const seedTasks = async (page: Page, listPageId: string, assigneeId: string): Promise<void> => {
  const tasks = [
    { title: 'Write the brief', status: 'completed', priority: 'medium', dueDate: '2026-03-09T00:00:00.000Z' },
    { title: 'Draft the announcement', status: 'in_progress', priority: 'high', dueDate: '2026-03-13T00:00:00.000Z', assigneeIds: [{ type: 'user', id: assigneeId }] },
    { title: 'Order banners', status: 'blocked', priority: 'low', dueDate: '2026-03-10T00:00:00.000Z' },
    { title: 'Pick a launch date', status: 'pending', priority: 'high', dueDate: '2026-03-20T00:00:00.000Z' },
    { title: 'Invite the press', status: 'pending', priority: 'medium' },
  ];
  const result = await page.evaluate(
    async ({ listPageId, tasks }) => {
      const csrf = (await (await fetch('/api/auth/csrf')).json()) as { csrfToken: string };
      const post = async (pageId: string, body: Record<string, unknown>) => {
        const response = await fetch(`/api/pages/${pageId}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`POST tasks ${response.status}: ${await response.text()}`);
        return (await response.json()) as { id: string; pageId: string };
      };
      const made: { id: string; pageId: string }[] = [];
      for (const [position, task] of tasks.entries()) made.push(await post(listPageId, { ...task, position }));
      // Two subtasks under the announcement, one done, so its card shows a subtask count.
      const announcement = made[1];
      if (announcement === undefined) throw new Error('no announcement task');
      await post(announcement.pageId, { title: 'Write the headline', status: 'completed', position: 0 });
      await post(announcement.pageId, { title: 'Pick the screenshots', position: 1 });
      return made.length;
    },
    { listPageId, tasks },
  );
  expect(result).toBe(tasks.length);
};

const openTasks = async (
  browser: Parameters<typeof visualBrowser>[0],
  baseURL: string | undefined,
): Promise<{ page: Page; driveId: string; listPageId: string }> => {
  const user = await person('Ada Lovelace');
  const driveId = await teamDrive(user);
  const list = await factories.createPage(driveId, {
    type: 'TASK_LIST',
    title: LIST,
    content: '',
    position: 1,
    createdAt: at('09:00'),
    updatedAt: at('09:00'),
  });
  const page = await open(browser, baseURL, user, imagoPath(driveId, `tasks/${list.id}`));
  await seedTasks(page, list.id, user.id);
  return { page, driveId, listPageId: list.id };
};

test('task list', async ({ browser, baseURL }) => {
  const { page } = await openTasks(browser, baseURL);
  await page.reload();

  await compare(page, baseURL, 'task-list', async (shown) => {
    await expect(shown.getByRole('button', { name: 'Table view', exact: true })).toBeVisible({ timeout: LOAD_MS });
    const tree = shown.locator('[data-slot="object"]');
    await selectTaskFilter(shown, 'All');
    await expect(tree.getByRole('checkbox', { name: 'Complete Invite the press', exact: true })).toBeVisible();
    await expect(tree.getByRole('checkbox', { name: 'Reopen Write the brief', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

test('task board', async ({ browser, baseURL }) => {
  const { page } = await openTasks(browser, baseURL);
  // The Board is the viewer's saved view, so it survives the reloads `compare` makes.
  await page.reload();
  await page.getByRole('button', { name: 'Kanban view', exact: true }).click();

  await compare(page, baseURL, 'task-board', async (shown) => {
    const board = shown.getByRole('group', { name: 'Task board', exact: true });
    await expect(board.getByRole('region', { name: 'To Do', exact: true }).getByRole('heading')).toHaveAccessibleName(
      'To Do, 2 tasks',
      { timeout: LOAD_MS },
    );
    await expect(board.getByRole('article', { name: 'Draft the announcement', exact: true })).toBeVisible();
  });
});
