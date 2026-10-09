import { DEFAULT_AI_PROVIDER, DEFAULT_AI_MODEL } from '@pagespace/lib/ai/model-defaults';
import { expect, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { provisionHomeDriveIfNeeded } from '@pagespace/lib/onboarding/home-drive';
import { hydrated, signIn, type ImagoUser } from './imago.fixture';

/**
 * Visual baseline fixtures for imago (IMG-10.4), shared by the baseline spec (34) and its
 * token negative control (35).
 *
 * A baseline is only worth locking if nothing but the code under it can move a pixel, so
 * every input to the frame is pinned here:
 *
 *  - Frame: 1400×800 CSS pixels at device scale 1, UTC, en-US.
 *  - Theme: classic's `theme` cookie, which imago's root layout renders as `data-theme`, so the
 *    served HTML is already in the mode under test; the emulated color scheme agrees with it.
 *  - Motion: reduced motion, which imago's tokens answer by zeroing every duration (IMG-2.1),
 *    on top of toHaveScreenshot's own `animations: 'disabled'` and hidden caret.
 *  - Clock: the browser's Date is fixed at FIXED_NOW (timers still run, so SWR and sockets work),
 *    and every timestamp the frame can show is seeded or rewritten to a fixed moment before it.
 *  - People: fixed names, no avatar images, so initials and colours never vary.
 */

export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

/** The moment the browser believes it is. Everything shown is earlier the same UTC day. */
export const FIXED_NOW = new Date('2026-03-12T15:00:00.000Z');

/** A fixed time of FIXED_NOW's day, `HH:MM` in UTC. */
export const at = (time: string): Date => new Date(`2026-03-12T${time}:00.000Z`);

export const VIEWPORT = { width: 1400, height: 800 } as const;

/** A verified user with a fixed name and no avatar image, plus the Home drive sign-in provisions. */
export const visualUser = async (name: string): Promise<ImagoUser> => {
  const user = await factories.createUser({ name, image: null, emailVerified: new Date(), currentAiProvider: DEFAULT_AI_PROVIDER, currentAiModel: DEFAULT_AI_MODEL });
  const { driveId } = await provisionHomeDriveIfNeeded(user.id);
  return { id: user.id, name, homeDriveId: driveId };
};

/**
 * The page's requests in flight, other than socket.io's. Playwright's `networkidle` cannot be
 * used: socket.io's long-polling transport always has a request open until it upgrades to a
 * websocket, and on the CI runner it may never upgrade, so the page is never idle by that
 * measure. What a baseline needs is that nothing the frame draws is still being fetched.
 */
type Traffic = { inFlight: Set<Request>; lastChange: number };
const traffic = new WeakMap<Page, Traffic>();

const isSocketIo = (url: string): boolean => new URL(url).pathname.startsWith('/socket.io/');

const watchRequests = (page: Page): void => {
  const state: Traffic = { inFlight: new Set(), lastChange: Date.now() };
  traffic.set(page, state);
  page.on('request', (request) => {
    if (isSocketIo(request.url())) return;
    state.inFlight.add(request);
    state.lastChange = Date.now();
  });
  const done = (request: Request) => {
    if (state.inFlight.delete(request)) state.lastChange = Date.now();
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
};

/** No request but socket.io's has been in flight for QUIET_MS. */
const QUIET_MS = 500;
const quiet = async (page: Page): Promise<void> => {
  const state = traffic.get(page);
  if (state === undefined) throw new Error('requests are not watched on this page: open it with visualBrowser');
  await expect
    .poll(() => state.inFlight.size === 0 && Date.now() - state.lastChange >= QUIET_MS, {
      message: 'requests still in flight',
      timeout: 30_000,
      intervals: [100],
    })
    .toBe(true);
};

/** A browser context in the pinned frame, theme and clock, not yet signed in. */
export const visualBrowser = async (
  browser: Browser,
  baseURL: string,
  theme: Theme,
): Promise<{ context: BrowserContext; page: Page }> => {
  const context = await browser.newContext({
    baseURL,
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    locale: 'en-US',
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  await setTheme(context, baseURL, theme);
  const page = await context.newPage();
  watchRequests(page);
  await page.clock.setFixedTime(FIXED_NOW);
  return { context, page };
};

/** Classic's theme cookie, which both apps read; imago serves its HTML in that mode. */
export const setTheme = async (context: BrowserContext, baseURL: string, theme: Theme): Promise<void> => {
  await context.addCookies([{ name: 'theme', value: theme, url: baseURL }]);
};

/** Signs in through the magic-link route and waits for the shell to hydrate on `path`. */
export const openSignedIn = async (page: Page, user: ImagoUser, path: string): Promise<void> => {
  await signIn(page, user, path);
  await hydrated(page);
};

/**
 * The frame at rest: hydrated, in the theme asked for, with the clock pinned, every web font
 * loaded and decoded, and no request in flight. Each spec then waits for the content it
 * expects before it compares, so a half-loaded list is never what gets locked.
 */
export const settle = async (page: Page, theme: Theme): Promise<void> => {
  await hydrated(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  expect(await page.evaluate(() => new Date().toISOString()), 'the browser clock is not pinned').toBe(
    FIXED_NOW.toISOString(),
  );
  // Every stylesheet the document links has loaded. A page whose CSS 404s (a server left
  // running on an older build's HTML, say) still renders, unstyled, and must never be what a
  // baseline locks or is compared against.
  const sheets = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).map((link) => ({
      href: link.href,
      loaded: link.sheet !== null,
    })),
  );
  expect(sheets.length, 'the page links no stylesheet').toBeGreaterThan(0);
  expect(sheets.filter((sheet) => !sheet.loaded), 'stylesheets that did not load').toEqual([]);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  expect(await page.evaluate(() => document.fonts.status)).toBe('loaded');
  await quiet(page);
};

/** Switches an open page to `theme`: the cookie, the emulated scheme, then a reload. */
export const switchTheme = async (page: Page, baseURL: string, theme: Theme): Promise<void> => {
  await setTheme(page.context(), baseURL, theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.reload();
};

/**
 * Pins a chat conversation's timestamps (made by a real send, so stamped with the real time)
 * to fixed moments, in send order, so the history's day groups and anything else dated read
 * the same on every run. The times must be strictly increasing: the thread is ordered by
 * them, and a tie lets a reply draw above its prompt.
 */
export const pinConversation = async (conversationId: string, times: readonly Date[]): Promise<void> => {
  const rows = await db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);
  expect(rows.length, 'messages to pin').toBe(times.length);
  expect(
    times.every((time, index) => index === 0 || time > (times[index - 1] ?? time)),
    'pinned times must strictly increase',
  ).toBe(true);
  for (const [index, row] of rows.entries()) {
    await db.update(messages).set({ createdAt: times[index] }).where(eq(messages.id, row.id));
  }
  const first = times[0];
  const last = times[times.length - 1];
  if (first === undefined || last === undefined) throw new Error('no times to pin');
  await db
    .update(conversations)
    .set({ createdAt: first, updatedAt: last, lastMessageAt: last })
    .where(eq(conversations.id, conversationId));
};

/**
 * A team drive of `owner`'s with nothing in it but what the test seeds. The files, messages and
 * tasks surfaces use one rather than the Home drive, whose onboarding pages (a Getting Started
 * folder and task list among them) would put content this spec does not own into the frame.
 */
export const teamDrive = async (owner: ImagoUser): Promise<string> => {
  const drive = await factories.createDrive(owner.id, {
    name: 'Northwind',
    slug: 'northwind',
    createdAt: at('08:00'),
    updatedAt: at('08:00'),
  });
  return drive.id;
};

/** A small drive tree, every row dated at a fixed moment of the pinned day. */
export const seedFiles = async (driveId: string) => {
  const dated = { createdAt: at('09:00'), updatedAt: at('11:30') };
  const projects = await factories.createPage(driveId, { type: 'FOLDER', title: 'Projects', content: '', position: 1, ...dated });
  await factories.createPage(driveId, { type: 'FOLDER', title: 'Research', content: '', position: 2, ...dated });
  await factories.createPage(driveId, {
    type: 'DOCUMENT',
    title: 'Meeting notes',
    content: '<p>Notes from the weekly sync.</p>',
    position: 3,
    ...dated,
  });
  const brief = await factories.createPage(driveId, {
    type: 'DOCUMENT',
    title: 'Launch brief',
    content:
      '<h1>Launch brief</h1><p>Imago is the new home for chat, files, messages and tasks.</p>' +
      '<h2>Goals</h2><ul><li>One calm surface for every drive.</li><li>Agents beside the work.</li></ul>' +
      '<p>Ship the preview to the team first, then widen it.</p>',
    parentId: projects.id,
    position: 1,
    ...dated,
  });
  await factories.createPage(driveId, {
    type: 'FOLDER',
    title: 'Design',
    content: '',
    parentId: projects.id,
    position: 2,
    ...dated,
  });
  await factories.createPage(driveId, {
    type: 'DOCUMENT',
    title: 'Budget',
    content: '<p>Q2 budget.</p>',
    parentId: projects.id,
    position: 3,
    updatedAt: at('08:15'),
    createdAt: at('08:00'),
  });
  return { projects, brief };
};

/** The Projects folder from seedFiles, open in the folder browser, with the tree beside it. */
export const filesReady = async (page: Page): Promise<void> => {
  const table = page.getByRole('region', { name: 'Projects', exact: true }).getByRole('table', {
    name: 'Projects contents',
  });
  await expect(table.getByRole('row')).toHaveCount(4, { timeout: 30_000 });
  // The tree opens collapsed: the drive's three top-level rows.
  await expect(
    page.locator('[data-slot="list"]').getByRole('navigation', { name: 'File tree', exact: true }).getByRole('link'),
  ).toHaveCount(3);
};
