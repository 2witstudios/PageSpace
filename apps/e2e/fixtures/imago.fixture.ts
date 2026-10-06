import { createId } from '@paralleldrive/cuid2';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { inArray, or } from '@pagespace/db/operators';
import { users, verificationTokens } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { sessions } from '@pagespace/db/schema/sessions';
import { dmConversations } from '@pagespace/db/schema/social';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { provisionHomeDriveIfNeeded } from '@pagespace/lib/onboarding/home-drive';

/**
 * Imago browser fixtures (IMG-3.5, IMG-8.6).
 *
 * Imago specs run on one origin, as production does: the e2e proxy (support/e2e-proxy.ts)
 * serves /imago from apps/imago's production build, /socket.io from realtime and everything
 * else — classic's sign-in and /api included — from web. See 27-imago-shell.spec.ts for why
 * imago must be the production build.
 */

/** The shell frame; its data attributes name the stage. */
export const shell = (page: Page): Locator => page.locator('[data-section]');

/**
 * The shell once React has hydrated it. Before then the markup is the server's and inert: a
 * click on a Link would be a full document load, and typed text would be dropped. The shell
 * marks its frame `data-hydrated` from the first render after hydration (ui/frame/shell/
 * use-hydrated.ts), a public signal rather than a React internal.
 */
export const hydrated = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-section][data-hydrated]')).toHaveCount(1);
};

/** An imago address under the /imago basePath. */
export const imagoPath = (driveId: string, section = ''): string =>
  section === '' ? `/imago/${driveId}` : `/imago/${driveId}/${section}`;

export const pathnameIs = (path: string) => (url: URL) => url.pathname === path;

/**
 * The link classic's magic-link email carries for `next` (apps/web
 * lib/auth/magic-link-adapters.ts): the token row is minted as the email adapter mints it,
 * because the run has no mailbox to receive it. Everything after the click is the real path:
 * web's verify route redeems the token, sets the session cookie and redirects to `next`.
 */
export const emailedMagicLink = async (userId: string, next: string): Promise<string> => {
  const { token, hash, tokenPrefix } = generateToken('ps_magic');
  await db.insert(verificationTokens).values({
    id: createId(),
    userId,
    tokenHash: hash,
    tokenPrefix,
    type: 'magic_link',
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  });
  return `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
};

export type ImagoUser = { readonly id: string; readonly name: string; readonly homeDriveId: string };

/** A verified user with the Home drive every user gets at sign-in. */
export const imagoUser = async (name: string): Promise<ImagoUser> => {
  const user = await factories.createUser({ name, emailVerified: new Date() });
  const { driveId } = await provisionHomeDriveIfNeeded(user.id);
  return { id: user.id, name, homeDriveId: driveId };
};

/**
 * A browser of the user's own, not yet signed in. A context made by hand does not inherit the
 * project's baseURL, so it is passed in.
 */
export const freshBrowser = async (
  browser: Browser,
  baseURL: string,
): Promise<{ context: BrowserContext; page: Page }> => {
  const context = await browser.newContext({ baseURL });
  return { context, page: await context.newPage() };
};

/** Signs `page`'s browser in as `user` through the magic-link verify route, landing on `next`. */
export const signIn = async (page: Page, user: ImagoUser, next: string): Promise<void> => {
  await page.goto(await emailedMagicLink(user.id, next));
  await page.waitForURL(pathnameIs(next));
};

/**
 * Deletes the users a spec created and everything that hangs off them (drives and their
 * pages, sessions, tokens, DMs: all cascade from users), then proves nothing is left.
 */
export const deleteUsers = async (ids: readonly string[]): Promise<void> => {
  if (ids.length === 0) return;
  await db.delete(users).where(inArray(users.id, [...ids]));
  const [left, owned, live, talks] = await Promise.all([
    db.select({ id: users.id }).from(users).where(inArray(users.id, [...ids])),
    db.select({ id: drives.id }).from(drives).where(inArray(drives.ownerId, [...ids])),
    db.select({ id: sessions.id }).from(sessions).where(inArray(sessions.userId, [...ids])),
    db
      .select({ id: dmConversations.id })
      .from(dmConversations)
      .where(or(inArray(dmConversations.participant1Id, [...ids]), inArray(dmConversations.participant2Id, [...ids]))),
  ]);
  expect(
    { users: left.length, drives: owned.length, sessions: live.length, conversations: talks.length },
    'rows left behind after deleting the spec’s users',
  ).toEqual({ users: 0, drives: 0, sessions: 0, conversations: 0 });
};

/**
 * What a page's socket.io connection carries, in both directions, whichever transport it is
 * on: socket.io opens with HTTP long-polling and then upgrades to a websocket, so a packet
 * can travel either way. Engine.IO v4 joins packets in one polling body with \x1e.
 *
 * Install it before the page navigates, or the first packets are missed.
 */
export const watchSocket = (page: Page) => {
  const sent: string[] = [];
  const received: string[] = [];
  const isSocketIo = (url: string) => new URL(url).pathname.startsWith('/socket.io/');
  page.on('request', (request) => {
    if (request.method() === 'POST' && isSocketIo(request.url())) {
      sent.push(...(request.postData() ?? '').split('\x1e'));
    }
  });
  page.on('response', async (response) => {
    const request = response.request();
    if (request.method() !== 'GET' || !isSocketIo(response.url())) return;
    const body = await response.text().catch(() => '');
    received.push(...body.split('\x1e'));
  });
  page.on('websocket', (ws) => {
    if (!isSocketIo(ws.url())) return;
    ws.on('framesent', ({ payload }) => {
      sent.push(String(payload));
    });
    ws.on('framereceived', ({ payload }) => {
      received.push(String(payload));
    });
  });
  return {
    /**
     * realtime has accepted the connection: its CONNECT packet (`40…`) arrived. realtime joins
     * the user's own rooms (notifications:<id> among them) synchronously in its connection
     * handler, before anything later can be broadcast to them.
     */
    connected: () => expect.poll(() => received.some((packet) => packet.startsWith('40'))).toBe(true),
    /** The page asked realtime to join `room` with `event` (a `42["event","room"]` packet). */
    asked: (event: string, room: string) =>
      expect.poll(() => sent.includes(`42${JSON.stringify([event, room])}`)).toBe(true),
  };
};
