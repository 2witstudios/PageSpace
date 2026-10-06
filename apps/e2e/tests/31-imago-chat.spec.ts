import { test, expect, type BrowserContext, type Page } from '@playwright/test';
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
import { mockStreams, releaseStreams, resetMock, setStreamConfig } from '../support/http';

/**
 * # Chat in imago, end to end (IMG-6.6)
 *
 * One user signs in through the real magic-link route and talks to their Imago agent in the
 * shell. Web, realtime, imago (its production build behind the e2e proxy) and Postgres are
 * real; only the model is mocked: web's OpenRouter provider points at Playwright's mock
 * (support/mock-openrouter.ts), whose pacing the spec sets per test. A send therefore travels
 * the composer → POST /api/ai/chat → page-chat turn → provider → mock, and the reply comes
 * back as web's UI message stream into the pane; the stored thread is read back from
 * /api/ai/page-agents/[agentId]/conversations after a reload.
 *
 * The user is created as factories.createUser makes one (provider zai, the default, which web
 * serves through OpenRouter's managed key and base URL), with the Home drive and Imago agents
 * that sign-in provisions. No conversation or message is seeded: every one is made by a send.
 *
 * ## Requires
 *
 * The topology of 27-imago-shell.spec.ts (the CI `e2e` job), with web started on
 * OPENROUTER_DEFAULT_API_KEY and OPENROUTER_BASE_URL pointing at the mock.
 *
 * ## Same document
 *
 * Draft and history claims are about the shell, not about a page load, so each of those tests
 * writes a probe onto `window` and requires it at the end: a reload or a document navigation
 * drops it.
 */

type Probed = Window & { __probe?: string };

// A send does real work before the provider call (context, writes, provisioning checks), and
// web may compile a route on first use; per-assertion ceilings below fail first.
test.setTimeout(120_000);

const TURN_MS = 30_000;

const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const railLink = (page: Page, name: string) => rail(page).getByRole('link', { name, exact: true });
const chat = (page: Page) => page.getByRole('region', { name: 'Chat', exact: true });
const composer = (page: Page) => chat(page).getByRole('textbox', { name: 'Message Imago' });
const sendButton = (page: Page) => chat(page).getByRole('button', { name: 'Send' });
const stopButton = (page: Page) => chat(page).getByRole('button', { name: 'Stop' });
const said = (page: Page, role: 'user' | 'assistant') => chat(page).locator(`li[data-role="${role}"]`);
const history = (page: Page) => page.locator('[data-slot="list"]').getByRole('region', { name: 'Chat history' });
const historyRow = (page: Page, title: string) => history(page).getByRole('button', { name: title, exact: true });

const tagDocument = (page: Page) =>
  page.evaluate(() => {
    (window as Probed).__probe = 'same document';
  });
const probeOf = (page: Page) => page.evaluate(() => (window as Probed).__probe ?? null);

/**
 * The chat ready for a prompt: hydrated, and the agent's conversations listed (until then the
 * pane does not know which conversation is latest, and Send stays off).
 */
const ready = async (page: Page): Promise<void> => {
  await hydrated(page);
  // The lists are server reads: allowed a turn's ceiling, since a cold server compiles a route first.
  await expect(history(page).getByRole('status')).toHaveCount(0, { timeout: TURN_MS });
  await expect(chat(page).locator('ol[aria-busy="true"]')).toHaveCount(0, { timeout: TURN_MS });
};

/** Types a prompt and sends it with Enter, as a person does. */
const ask = async (page: Page, prompt: string): Promise<void> => {
  await composer(page).fill(prompt);
  await expect(sendButton(page)).toBeEnabled();
  await composer(page).press('Enter');
  await expect(composer(page)).toHaveValue('');
};

/** The turn has ended in the pane: no reply is busy and Send stands where Stop was. */
const turnEnded = async (page: Page): Promise<void> => {
  await expect(stopButton(page)).toHaveCount(0, { timeout: TURN_MS });
  await expect(chat(page).locator('li[aria-busy="true"]')).toHaveCount(0);
};

let user: ImagoUser;
let created: string[] = [];
const contexts: BrowserContext[] = [];

test.beforeEach(async ({ request }) => {
  await resetMock(request);
  user = await imagoUser(`Ada ${Math.random().toString(36).slice(2, 8)}`);
  created = [user.id];
});

// In teardown, not inline, so a failing assertion never leaks a browser, a held stream or a row.
test.afterEach(async ({ request }) => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await resetMock(request);
  await deleteUsers(created);
});

/** The user's own browser, signed in through the magic-link verify route and landed on `next`. */
const signedIn = async (
  browser: Parameters<typeof freshBrowser>[0],
  baseURL: string | undefined,
  next: string,
): Promise<Page> => {
  const { context, page } = await freshBrowser(browser, baseURL ?? '');
  contexts.push(context);
  await signIn(page, user, next);
  return page;
};

test('a prompt streams its reply in, and both are there after a reload', async ({ browser, baseURL, request }) => {
  // 12 chunks, 250 ms apart: a three-second window to watch the reply grow.
  await setStreamConfig(request, { mode: 'slow', chunks: 12, intervalMs: 250 });
  const home = imagoPath(user.homeDriveId);
  const page = await signedIn(browser, baseURL, home);
  await ready(page);
  await expect(chat(page)).toContainText('Ask Imago anything.');

  await ask(page, 'What ships in October?');

  // The prompt is the viewer's card at once; the reply is live at the model and in the pane.
  await expect(said(page, 'user')).toHaveText(/What ships in October\?/);
  await expect.poll(() => mockStreams(request).then((streams) => streams.open), { timeout: TURN_MS }).toBe(1);
  const reply = said(page, 'assistant');
  await expect(reply).toHaveAttribute('aria-busy', 'true');
  await expect(stopButton(page)).toBeVisible();

  // Streamed, not delivered whole: the same reply holds an early chunk before the last one.
  await expect(reply).toContainText('chunk-0');
  expect(await reply.textContent(), 'the reply arrived whole').not.toContain('chunk-11');
  await expect(reply).toContainText('chunk-11', { timeout: TURN_MS });
  await turnEnded(page);
  await expect(reply).toContainText(/chunk-0 chunk-1 .*chunk-11/);

  // The conversation is in the history under Today, named for its first prompt.
  await expect(historyRow(page, 'What ships in October?')).toHaveAttribute('aria-current', 'true');

  // A reload reads both back from the stored thread.
  await page.reload();
  await ready(page);
  await expect(said(page, 'user')).toHaveText(/What ships in October\?/);
  await expect(said(page, 'assistant')).toContainText(/chunk-0 chunk-1 .*chunk-11/);
  await expect(said(page, 'assistant')).not.toHaveAttribute('aria-busy', 'true');
  await expect(historyRow(page, 'What ships in October?')).toBeVisible();
});

test('Stop mid-stream keeps the partial reply, after a reload too', async ({ browser, baseURL, request }) => {
  // Held: the model sends its first chunk and nothing more until released or hung up on.
  await setStreamConfig(request, { mode: 'held' });
  const page = await signedIn(browser, baseURL, imagoPath(user.homeDriveId));
  await ready(page);

  await ask(page, 'Write me a long essay');
  await expect.poll(() => mockStreams(request).then((streams) => streams.held), { timeout: TURN_MS }).toBe(1);
  const reply = said(page, 'assistant');
  await expect(reply).toContainText('chunk-0');

  await stopButton(page).click();

  // The generation is over at the model: web hung up on it rather than letting it finish.
  await expect.poll(() => mockStreams(request).then((streams) => streams.open), { timeout: TURN_MS }).toBe(0);
  await turnEnded(page);
  await expect(reply).toContainText('chunk-0');
  await expect(chat(page).getByRole('alert')).toHaveCount(0);

  // Nothing is left at the model to finish the reply: a release finds no held stream (a
  // generation web kept, or one a retry opened after Stop, would be released here and its
  // chunk-1… stored into the reply, which the reload below would show).
  expect(await releaseStreams(request), 'held streams still open after Stop').toBe(0);
  await expect(sendButton(page)).toBeVisible();

  // The partial reply was stored as it stood.
  await page.reload();
  await ready(page);
  await expect(said(page, 'user')).toHaveText(/Write me a long essay/);
  await expect(said(page, 'assistant')).toContainText('chunk-0');
  expect(await said(page, 'assistant').textContent()).not.toContain('chunk-1');
});

test('a typed draft survives chat → files → chat, with the caret back in the composer', async ({
  browser,
  baseURL,
}) => {
  const home = imagoPath(user.homeDriveId);
  const files = imagoPath(user.homeDriveId, 'files');
  const page = await signedIn(browser, baseURL, home);
  await ready(page);
  await tagDocument(page);

  await composer(page).fill('Half a thought about the roadmap');

  await railLink(page, 'Files').click();
  await page.waitForURL(pathnameIs(files));
  await expect(page.locator('[data-section]')).toHaveAttribute('data-section', 'files');
  // The rail link took focus with the click: nothing has put it back yet.
  await expect(composer(page)).not.toBeFocused();

  await railLink(page, 'Chat').click();
  await page.waitForURL(pathnameIs(home));
  await expect(page.locator('[data-section]')).toHaveAttribute('data-section', 'chat');
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue('Half a thought about the roadmap');

  // Typing goes straight on from where it was: the caret is in the field, not merely on it.
  await page.keyboard.type(', continued');
  await expect(composer(page)).toHaveValue('Half a thought about the roadmap, continued');

  // Back to the chat under the ⌘K palette: the palette keeps the caret, nothing moves it behind the modal.
  await railLink(page, 'Files').click();
  await page.waitForURL(pathnameIs(files));
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('dialog', { name: 'Search' }).getByRole('combobox');
  await expect(search).toBeFocused();
  await page.goBack();
  await page.waitForURL(pathnameIs(home));
  await expect(page.locator('[data-section]')).toHaveAttribute('data-section', 'chat');
  await expect(search).toBeFocused();
  await expect(composer(page)).not.toBeFocused();
  expect(await probeOf(page), 'the page reloaded').toBe('same document');
});

test('the history switches between two conversations', async ({ browser, baseURL }) => {
  const page = await signedIn(browser, baseURL, imagoPath(user.homeDriveId));
  await ready(page);
  await tagDocument(page);

  // Two conversations, each made by a send: the first, then New chat and the second.
  await ask(page, 'Alpha question');
  await turnEnded(page);
  await expect(said(page, 'assistant')).toHaveText(/pong/);
  await expect(historyRow(page, 'Alpha question')).toHaveAttribute('aria-current', 'true');

  await history(page).getByRole('button', { name: 'New chat' }).click();
  await expect(chat(page)).toContainText('Ask Imago anything.');
  await ask(page, 'Beta question');
  await turnEnded(page);
  await expect(historyRow(page, 'Beta question')).toHaveAttribute('aria-current', 'true');
  await expect(historyRow(page, 'Alpha question')).not.toHaveAttribute('aria-current', 'true');

  const showing = async (prompt: string, other: string) => {
    await expect(historyRow(page, prompt)).toHaveAttribute('aria-current', 'true');
    await expect(historyRow(page, other)).not.toHaveAttribute('aria-current', 'true');
    await expect(said(page, 'user')).toHaveText(new RegExp(prompt));
    await expect(said(page, 'assistant')).toHaveText(/pong/);
  };

  await historyRow(page, 'Alpha question').click();
  await showing('Alpha question', 'Beta question');
  await historyRow(page, 'Beta question').click();
  await showing('Beta question', 'Alpha question');

  // A send goes to the conversation shown, not to the one last sent into.
  await historyRow(page, 'Alpha question').click();
  await showing('Alpha question', 'Beta question');
  await ask(page, 'Alpha follow-up');
  await turnEnded(page);
  await expect(said(page, 'user')).toHaveText([/Alpha question/, /Alpha follow-up/]);
  await historyRow(page, 'Beta question').click();
  await expect(said(page, 'user')).toHaveText([/Beta question/]);

  expect(await probeOf(page), 'the page reloaded').toBe('same document');
});
