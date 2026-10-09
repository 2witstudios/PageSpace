import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import {
  deleteUsers,
  freshBrowser,
  hydrated,
  imagoPath,
  imagoUser,
  pathnameIs,
  signIn,
  watchSocket,
  type ImagoUser,
} from '../fixtures/imago.fixture';

/**
 * # Messaging in imago, between two people (IMG-8.6)
 *
 * Two users, each signed in through the real magic-link route in a browser of their own,
 * against real web, realtime and imago servers and a real database. Nothing is mocked: a post
 * typed into one browser travels POST → apps/web → realtime → the other browser's socket →
 * SWR → the screen.
 *
 * ## Requires
 *
 * The same topology as 27-imago-shell.spec.ts (the CI `e2e` job): imago's production build
 * behind the e2e proxy at /imago (`E2E_IMAGO_TARGET`), and realtime on the same origin at
 * /socket.io — the shipped CSP is `connect-src 'self'`, so a realtime on another origin
 * connects no socket at all and nothing here could arrive.
 *
 * ## Live, not loaded
 *
 * "It appeared" is not by itself evidence of live delivery: a reload or a navigation would
 * also show it. So each receiving page carries a JS probe on `window` from before the send,
 * and the probe must survive to the end. A document load drops it.
 *
 * ## Ordering, without sleeps
 *
 * realtime delivers a room's broadcast only to sockets already in the room, and it has no
 * acknowledgement for a join. So the sender acts only after the receiver's socket has
 * connected (its own notification room is joined in realtime's connection handler, before
 * any later broadcast) or has asked to join the thread's room — and the sender's own sign-in
 * and page load stand between that and the send.
 */

type Probed = Window & { __probe?: string };

const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const railLink = (page: Page, name: string) => rail(page).getByRole('link', { name, exact: true });
const listLink = (page: Page, name: string) =>
  page.locator('[data-slot="list"]').getByRole('link', { name, exact: true });
const thread = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const post = (scope: Locator, text: string) => scope.getByRole('article').filter({ hasText: text });

/** A probe only the same document can still carry. */
const tagDocument = (page: Page) =>
  page.evaluate(() => {
    (window as Probed).__probe = 'same document';
  });
const probeOf = (page: Page) => page.evaluate(() => (window as Probed).__probe ?? null);

/** Types into the thread's composer and sends with Enter, then waits for apps/web to store it. */
const send = async (scope: Locator, text: string): Promise<void> => {
  const composer = scope.getByRole('combobox');
  await composer.fill(text);
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(post(scope, text)).toHaveCount(1);
  await expect(post(scope, text)).not.toHaveAttribute('aria-busy', 'true');
};

let created: string[] = [];
const contexts: BrowserContext[] = [];

/** Two people who share a team drive with a public channel in it. */
let poster: ImagoUser;
let reader: ImagoUser;
let driveId: string;
let channelId: string;

test.beforeEach(async () => {
  const run = Math.random().toString(36).slice(2, 8);
  poster = await imagoUser(`Ada ${run}`);
  reader = await imagoUser(`Grace ${run}`);
  created = [poster.id, reader.id];
  ({ id: driveId } = await factories.createDrive(poster.id, { name: `Team ${run}` }));
  await factories.createDriveMember(driveId, reader.id, { role: 'MEMBER' });
  ({ id: channelId } = await factories.createPage(driveId, { type: 'CHANNEL', title: 'general', isPrivate: false }));
});

// In teardown, not inline, so a failing assertion never leaks a browser or a row.
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await deleteUsers(created);
});

const open = async (browser: Parameters<typeof freshBrowser>[0], baseURL: string | undefined) => {
  const opened = await freshBrowser(browser, baseURL ?? '');
  contexts.push(opened.context);
  return { page: opened.page, socket: watchSocket(opened.page) };
};

test('a channel post from one member reaches the other live, with the unread badge', async ({
  browser,
  baseURL,
}) => {
  const messages = imagoPath(driveId, 'messages');
  const channel = imagoPath(driveId, `messages/${channelId}`);

  // The reader looks at the drive's Messages list, with nothing unread.
  const theirs = await open(browser, baseURL);
  await signIn(theirs.page, reader, messages);
  await hydrated(theirs.page);
  await expect(listLink(theirs.page, 'general')).toBeVisible();
  await expect(railLink(theirs.page, 'Messages')).toBeVisible();
  await theirs.socket.connected();
  await tagDocument(theirs.page);

  // The poster opens the channel and posts in it.
  const mine = await open(browser, baseURL);
  await signIn(mine.page, poster, channel);
  await hydrated(mine.page);
  await send(thread(mine.page, '# general'), 'first light');

  // The reader's list row and rail badge count it, in the same document.
  await expect(listLink(theirs.page, 'general, 1 unread')).toBeVisible();
  await expect(railLink(theirs.page, 'Messages, 1 unread')).toBeVisible();
  expect(await probeOf(theirs.page), 'the reader’s page reloaded').toBe('same document');

  // Opening the channel shows the post, by its author, and reading it clears the badge.
  await listLink(theirs.page, 'general, 1 unread').click();
  await theirs.page.waitForURL(pathnameIs(channel));
  const reading = thread(theirs.page, '# general');
  await expect(post(reading, 'first light')).toContainText(poster.name);
  await expect(railLink(theirs.page, 'Messages')).toBeVisible();

  // With the channel open on both sides, the next post arrives in the reader's thread live.
  await theirs.socket.asked('join_channel', channelId);
  await send(thread(mine.page, '# general'), 'second light');
  await expect(post(reading, 'second light')).toBeVisible();
  await expect(post(reading, 'first light')).toContainText(poster.name);
  expect(await probeOf(theirs.page), 'the reader’s page reloaded').toBe('same document');
});

test('a DM round-trips a message both ways', async ({ browser, baseURL }) => {
  // The poster starts the conversation through apps/web, as classic's "Message" button does:
  // from inside their signed-in page. Not `page.request`: in production web sets the session
  // cookie Secure, and Playwright's request context withholds Secure cookies over http while
  // Chromium (which trusts 127.0.0.1) sends them — so only the browser's own fetch is the
  // signed-in path on the CI origin.
  const mine = await open(browser, baseURL);
  await signIn(mine.page, poster, '/imago/dm');
  const started = await mine.page.evaluate(async (recipientId) => {
    const { csrfToken } = (await (await fetch('/api/auth/csrf')).json()) as { csrfToken: string };
    const response = await fetch('/api/messages/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ recipientId }),
    });
    return { status: response.status, body: await response.text() };
  }, reader.id);
  expect(started.status, started.body).toBe(200);
  const { conversation } = JSON.parse(started.body) as { conversation: { id: string } };
  const dm = `/imago/dm/${conversation.id}`;

  // The reader opens it, empty, named for the poster.
  const theirs = await open(browser, baseURL);
  await signIn(theirs.page, reader, dm);
  await hydrated(theirs.page);
  const readerThread = thread(theirs.page, poster.name);
  await expect(readerThread.getByRole('combobox')).toBeEditable();
  await expect(readerThread.getByRole('article')).toHaveCount(0);
  await theirs.socket.asked('join_dm_conversation', conversation.id);
  await tagDocument(theirs.page);

  // The poster opens it and writes; the reader sees it arrive.
  await mine.page.goto(dm);
  await hydrated(mine.page);
  const posterThread = thread(mine.page, reader.name);
  await expect(posterThread.getByRole('combobox')).toBeEditable();
  await expect(posterThread.getByRole('article')).toHaveCount(0);
  await mine.socket.asked('join_dm_conversation', conversation.id);
  await tagDocument(mine.page);
  await send(posterThread, 'are you there?');
  await expect(post(readerThread, 'are you there?')).toContainText(poster.name);

  // The reader answers; the poster sees it arrive.
  await send(readerThread, 'right here');
  await expect(post(posterThread, 'right here')).toContainText(reader.name);

  expect(await probeOf(theirs.page), 'the reader’s page reloaded').toBe('same document');
  expect(await probeOf(mine.page), 'the poster’s page reloaded').toBe('same document');
});
