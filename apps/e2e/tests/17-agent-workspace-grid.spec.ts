import {
  test,
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  CONSENT_COOKIE_NAME,
  defaultConsentState,
  rejectNonEssential,
  serializeConsentState,
} from '@pagespace/lib/consent';
import { seedUser, type SeededUser } from '../support/db';
import { sessionPost } from '../support/http';

/**
 * # Pane-grid convergence across two devices (epic Phase 3 — the client cutover)
 *
 * The executable proof that the pane grid is SERVER-AUTHORITATIVE rather than a
 * per-browser blob. In the blob era each tab owned its own localStorage copy of
 * the grid and pushed it back with a debounced whole-grid PUT, so two windows on
 * one session were two independent truths racing a last-write-wins save: a split
 * in one window was invisible in the other until a reload, and whichever window
 * PUT last silently erased the other's layout. There was no rev, so there was
 * nothing to converge ON.
 *
 * What replaced it, and what these specs pin:
 *  - every mutation leaves the store as ONE verb against a rev
 *    (`POST /api/agent-workspaces/[workspaceId]/workspace/verbs`);
 *  - the write lands in the pane ROWS and broadcasts `workspace:updated` on the
 *    `session:<id>` room, so the other window adopts it LIVE — no reload;
 *  - because the rows are the truth, a window opened afterwards sees the same
 *    grid: convergence is durable, not merely a message both tabs happened to
 *    receive.
 *
 * ## Topology
 *
 * Two independent `BrowserContext`s for the SAME user — the same two-window
 * shape `openTwoWindows` (`fixtures/dispatch.fixture.ts`) builds for the chat
 * surface, rebuilt here for the AGENTS surface because that fixture navigates to
 * an AI_CHAT page and this grid lives at `/dashboard/<driveId>/agents?workspace=…`.
 * Independent contexts mean independent `X-Browser-Session-Id`s, which is the
 * app's per-tab identity — this is the real two-device topology, not two tabs
 * sharing a store.
 *
 * ## Requires the realtime server
 *
 * The live half of every assertion here rides `broadcastWorkspaceUpdated` →
 * `${INTERNAL_REALTIME_URL}/api/broadcast` → the `session:<id>` room. With
 * `apps/realtime` not running the broadcast logs a warn and is skipped, and the
 * "no reload" assertions fail (correctly — the delivery really is absent). Run
 * the realtime service alongside the web app. There is no e2e job in CI, so
 * these run locally.
 */

// The project-wide `storageState` user is provider 'openai' and belongs to a
// drive these specs do not control; seed our own, exactly as the chat and
// dispatch specs do. Also keeps the specs order-independent under `workers: 1`.
test.use({ storageState: { cookies: [], origins: [] } });

// Opening the surface boots the agents console, a session record fetch and a
// socket handshake before the grid renders. Per-assertion ceilings stay the
// failure surface; passing runs are far under this.
test.setTimeout(120_000);

const PANE_BAR = 'pane-bar';
const SESSION_PANES = 'session-panes';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A logged-in context for a `seedUser()` token — the same cookie pair
 * `authedContext` (`fixtures/chat.fixture.ts`) plants, built here rather than
 * imported for ONE reason: `bypassCSP`.
 *
 * The app's CSP is `connect-src 'self' ws: wss:` (`middleware/security-headers.ts`).
 * Socket.IO opens with an XHR POLLING handshake before it upgrades, so when the
 * realtime service is served from a DIFFERENT ORIGIN than the app — which is
 * exactly the local e2e topology, app on one port and `apps/realtime` on
 * another — that first request is not `'self'`, is not `ws:`, and the browser
 * blocks it. No socket, no `workspace:updated`, and the live assertions here
 * would fail for a reason that has nothing to do with the pane grid.
 *
 * This is a HARNESS artifact, not a product finding: a real deployment reaches
 * realtime same-origin. Bypassing CSP is scoped to this spec deliberately —
 * `authedContext` stays CSP-honest for every other spec, and this file does not
 * touch the shared fixture.
 */
async function gridContext(
  browser: Browser,
  sessionToken: string,
  baseURL: string,
): Promise<BrowserContext> {
  const url = new URL(baseURL);
  const context = await browser.newContext({ baseURL, bypassCSP: true });
  const decided = rejectNonEssential(defaultConsentState(), new Date(0).toISOString());
  await context.addCookies([
    {
      name: 'session',
      value: sessionToken,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      secure: url.protocol === 'https:',
      sameSite: 'Strict',
      expires: Math.floor((Date.now() + SESSION_TTL_MS) / 1000),
    },
    {
      name: CONSENT_COOKIE_NAME,
      value: encodeURIComponent(serializeConsentState(decided)),
      domain: url.hostname,
      path: '/',
      httpOnly: false,
      secure: url.protocol === 'https:',
      sameSite: 'Lax',
    },
  ]);
  return context;
}

// Closed in teardown, never inline, so a failing assertion cannot leak a context.
const openContexts: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(openContexts.map((context) => context.close()));
  openContexts.length = 0;
});

/**
 * Create a chat-only agent session through the front door.
 *
 * `{ driveId }` with no `firstThing` is the assistant-first shape: it mints the
 * session plus its opening conversation and provisions NO sandbox — deliberate,
 * since a real sandbox would make these specs slow and infrastructure-dependent
 * for a layout question that has nothing to do with compute.
 */
async function createSession(
  request: APIRequestContext,
  user: SeededUser,
): Promise<{ sessionId: string; conversationId: string }> {
  const response = await sessionPost(request, '/api/agent-workspaces', user, {
    driveId: user.driveId,
    name: 'grid convergence spec',
  });
  if (!response.ok()) {
    throw new Error(
      `createSession: POST /api/agent-workspaces answered ${response.status()}: ${(await response.text()).slice(0, 500)}`,
    );
  }
  const body = (await response.json()) as { session: { workspaceId: string }; conversationId: string };
  return { sessionId: body.session.workspaceId, conversationId: body.conversationId };
}

/**
 * Open one window on a session's grid and wait until it has actually rendered
 * `expectedPanes` pane bars.
 *
 * The deep link is the whole navigation — `AgentsSurface` mounts `AgentPanes`
 * off `?workspace=`, and `?c=` seeds the opening conversation. Waiting on a pane
 * COUNT rather than on the container is what makes the later assertions
 * meaningful: it pins the window's starting grid, so a change observed
 * afterwards is genuinely a change.
 */
async function openGridWindow(
  browser: Browser,
  user: SeededUser,
  baseURL: string,
  session: { sessionId: string; conversationId: string },
  expectedPanes = 1,
): Promise<Page> {
  const context = await gridContext(browser, user.sessionToken, baseURL);
  openContexts.push(context);
  const page = await context.newPage();
  await page.goto(
    `/dashboard/${user.driveId}/agents?workspace=${session.sessionId}&c=${session.conversationId}`,
  );
  await page.getByTestId(SESSION_PANES).waitFor({ state: 'visible', timeout: 60_000 });
  await expect(page.getByTestId(PANE_BAR)).toHaveCount(expectedPanes, { timeout: 60_000 });
  return page;
}

/** Split the FIRST pane to the right. The control is accessible-name only (`PaneBar.tsx`). */
async function splitFirstPaneRight(page: Page): Promise<void> {
  await page.getByTestId(PANE_BAR).first().getByRole('button', { name: 'Split right' }).click();
}

test.describe('pane grid — two devices on one session', () => {
  test('a split in one window appears in the other LIVE, with no reload', async ({
    browser,
    baseURL,
    request,
  }) => {
    const user = await seedUser();
    const session = await createSession(request, user);

    // Window A first, and only once IT has settled on one pane does window B
    // open: both windows deep-linking into a session with no grid yet would
    // have both of them seeding it, and the point under test is convergence
    // after a mutation, not the seed race (which the store's own 409 rebase
    // covers in `workspace-verb-queue.test.ts`).
    const windowA = await openGridWindow(browser, user, baseURL!, session);
    const windowB = await openGridWindow(browser, user, baseURL!, session);

    await splitFirstPaneRight(windowA);

    // The acting window renders optimistically — through the same shared
    // reducer the server runs — so this is immediate.
    await expect(windowA.getByTestId(PANE_BAR)).toHaveCount(2);

    // THE ASSERTION. Window B never reloaded and never clicked anything: the
    // second pane can only have come from `workspace:updated` on the
    // `session:<id>` room. This is the exact thing the blob era could not do.
    await expect(windowB.getByTestId(PANE_BAR)).toHaveCount(2, { timeout: 30_000 });

    // …and it arrived as a real UNBOUND pane, not just a count — the split
    // pane renders the picker until something is bound into it.
    await expect(windowB.getByTestId('pane-picker')).toBeVisible({ timeout: 30_000 });
  });

  test('convergence is DURABLE: a window opened afterwards sees the same grid', async ({
    browser,
    baseURL,
    request,
  }) => {
    const user = await seedUser();
    const session = await createSession(request, user);

    const windowA = await openGridWindow(browser, user, baseURL!, session);
    await splitFirstPaneRight(windowA);
    await expect(windowA.getByTestId(PANE_BAR)).toHaveCount(2);

    // A third window that was not connected when the verb was applied — so no
    // broadcast could have reached it. It reads the grid from the ROWS on
    // mount, which is what distinguishes "the panes are server state" from
    // "both tabs happened to get the same message".
    const windowC = await openGridWindow(browser, user, baseURL!, session, 2);
    await expect(windowC.getByTestId(PANE_BAR)).toHaveCount(2);
  });

  test('converges in BOTH directions: a close in the second window reaches the first', async ({
    browser,
    baseURL,
    request,
  }) => {
    const user = await seedUser();
    const session = await createSession(request, user);

    const windowA = await openGridWindow(browser, user, baseURL!, session);
    const windowB = await openGridWindow(browser, user, baseURL!, session);

    await splitFirstPaneRight(windowA);
    await expect(windowA.getByTestId(PANE_BAR)).toHaveCount(2);
    await expect(windowB.getByTestId(PANE_BAR)).toHaveCount(2, { timeout: 30_000 });

    // Now B acts and A observes — the reverse of the first spec. Under the
    // blob's last-write-wins PUT this direction was exactly where a layout got
    // silently erased; under a rev it is the same one verb, the other way.
    // Close the SECOND pane (the split one): closing the last pane is a
    // session-lifecycle act, not a layout verb, and would end the session.
    await windowB.getByTestId(PANE_BAR).nth(1).getByRole('button', { name: 'Close pane' }).click();

    await expect(windowB.getByTestId(PANE_BAR)).toHaveCount(1);
    await expect(windowA.getByTestId(PANE_BAR)).toHaveCount(1, { timeout: 30_000 });
  });
});
