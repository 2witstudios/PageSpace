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
import { removeSessionShell, seedSessionShell, seedUser, type SeededUser } from '../support/db';
import { sessionDelete, sessionGet, sessionPost } from '../support/http';

/**
 * # Pane LIFECYCLE — what a shell's pane does when the shell goes, and where a
 * new pane lands (issues #2462, #2469, #2473)
 *
 * The sibling of `17-agent-workspace-grid.spec.ts`, which pins that the grid is
 * server-authoritative. This one pins the three things a real working session
 * found on 2026-08-22 that a green unit suite did not:
 *
 *  - **#2462** — `kill_shell` answered `killed: true` and left the pane on
 *    screen, bound to a terminal that no longer existed. The DELETE now expels
 *    the node in the same write, which is only PROVABLE in a second window: a
 *    local store could have dropped the pane by itself, a broadcast could not.
 *  - **#2469** — every pane an agent opened split beside the last one, so three
 *    shells made three columns and the layout was unusable. Asserted against the
 *    node ROWS rather than the DOM, because "packed" is a fact about the tree.
 *  - **#2473** — closing the pane of a shell that was already gone toasted
 *    "Could not close the shell / Shell not found" for a close that had
 *    succeeded.
 *
 * ## Requires the realtime server
 *
 * Same dependency as spec 17: the live half rides
 * `broadcastWorkspaceNodesUpdated` → the `session:<id>` room. Run `apps/realtime`
 * alongside the web app or the cross-window assertions fail — correctly, since
 * the delivery really is absent.
 *
 * ## No sandbox
 *
 * Shells are seeded as ROWS (`seedSessionShell`), which is the state a shell is
 * in before its PTY is ever opened: `spriteExecId` null, nothing running. The
 * product's own spawn route provisions a Sprite first and is therefore
 * infrastructure-dependent; none of the three defects above is about compute.
 * The kill path runs end to end regardless — with no sandbox to reach, it drops
 * the row and expels the node, which is exactly the half under test.
 */

test.use({ storageState: { cookies: [], origins: [] } });
test.setTimeout(180_000);

const PANE_BAR = 'pane-bar';
const SESSION_PANES = 'session-panes';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** See spec 17's `gridContext` for why `bypassCSP` is here: cross-origin realtime in the local topology. */
async function gridContext(browser: Browser, sessionToken: string, baseURL: string): Promise<BrowserContext> {
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

const openContexts: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(openContexts.map((context) => context.close()));
  openContexts.length = 0;
});

/** A chat-only session — no `firstThing`, so no sandbox is provisioned. */
async function createSession(
  request: APIRequestContext,
  user: SeededUser,
): Promise<{ sessionId: string; conversationId: string }> {
  const response = await sessionPost(request, '/api/agent-workspaces', user, {
    driveId: user.driveId,
    name: 'pane lifecycle spec',
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
 * One window on a session's grid, settled on `expectedPanes` pane bars.
 *
 * `seedConversation` is what the second window turns OFF, and the reason is a
 * real behaviour rather than a harness detail: `?c=` tells the surface to SHOW
 * that conversation, and showing one the tree no longer holds PLACES it — so a
 * second window deep-linked to a conversation the first window's shell
 * displaced would ADD a pane rather than observe the grid. The window that is
 * there to watch must not write.
 */
async function openGridWindow(
  browser: Browser,
  user: SeededUser,
  baseURL: string,
  session: { sessionId: string; conversationId: string },
  expectedPanes = 1,
  seedConversation = true,
): Promise<Page> {
  const context = await gridContext(browser, user.sessionToken, baseURL);
  openContexts.push(context);
  const page = await context.newPage();
  const conversation = seedConversation ? `&c=${session.conversationId}` : '';
  await page.goto(`/dashboard/${user.driveId}/agents?workspace=${session.sessionId}${conversation}`);
  await page.getByTestId(SESSION_PANES).waitFor({ state: 'visible', timeout: 60_000 });
  await expect(page.getByTestId(PANE_BAR)).toHaveCount(expectedPanes, { timeout: 60_000 });
  return page;
}

/**
 * Open a seeded shell the way a user does: from its row in the session's
 * sidebar, which runs the store's `openShell` — the SAME placement policy the
 * server runs when an agent spawns one. That is what makes the packing
 * assertions below about production behaviour rather than about a test double.
 */
async function openShellFromSidebar(page: Page, sessionId: string, name: string): Promise<void> {
  const row = page.getByTestId(`sidebar-session-${sessionId}`);
  const expander = row.getByRole('button', { name: /^Expand / });
  if (await expander.isVisible().catch(() => false)) await expander.click();
  await row.getByRole('button', { name, exact: true }).click();
}

/** The pane bar of the pane showing this shell — a pane bar names what it holds. */
function paneBarFor(page: Page, shellName: string) {
  return page.getByTestId(PANE_BAR).filter({ hasText: shellName });
}

/** The workspace's node rows, read through the same GET the grid mounts on. */
async function readNodes(
  request: APIRequestContext,
  user: SeededUser,
  sessionId: string,
): Promise<Array<{ id: string; nodeType: string; parentId: string | null; axis?: string | null }>> {
  const response = await sessionGet(request, `/api/agent-workspaces/${sessionId}/nodes`, user);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    nodes: Array<{ id: string; nodeType: string; parentId: string | null; axis?: string | null }>;
  };
  return body.nodes;
}

/** How many containers stand between the root and the furthest pane. */
function deepestPane(nodes: Array<{ id: string; nodeType: string; parentId: string | null }>): number {
  const depthOf = (id: string): number => {
    const node = nodes.find((candidate) => candidate.id === id);
    if (node === undefined || node.parentId === null) return 0;
    return 1 + depthOf(node.parentId);
  };
  return Math.max(...nodes.filter((node) => node.nodeType === 'pane').map((node) => depthOf(node.id)));
}

test.describe('pane lifecycle — the shell, its pane, and where the next one lands', () => {
  test('killing a shell closes its pane in EVERY window, live (#2462)', async ({ browser, baseURL, request }) => {
    const user = await seedUser();
    const session = await createSession(request, user);
    await seedSessionShell(session.sessionId, user.userId, 'keeper');
    const shellId = await seedSessionShell(session.sessionId, user.userId, 'probe-alpha');

    // TWO shells, so the one being killed is not the workspace's LAST pane —
    // closing the last pane is a session-lifecycle act (it raises the end
    // confirm), which is a different question than this one.
    const windowA = await openGridWindow(browser, user, baseURL!, session);
    await openShellFromSidebar(windowA, session.sessionId, 'keeper');
    await openShellFromSidebar(windowA, session.sessionId, 'probe-alpha');
    await expect(paneBarFor(windowA, 'probe-alpha')).toHaveCount(1, { timeout: 30_000 });
    const paneCount = await windowA.getByTestId(PANE_BAR).count();

    // The second window mounts from the ROWS, so it starts out agreeing.
    const windowB = await openGridWindow(browser, user, baseURL!, session, paneCount, false);
    await expect(paneBarFor(windowB, 'probe-alpha')).toHaveCount(1, { timeout: 30_000 });

    // THE KILL, issued by neither window — so nothing local can account for
    // what happens next. Under the defect this answered `{ok: true, killed:
    // true}` and both windows kept the pane until someone reloaded.
    const killed = await sessionDelete(request, `/api/agent-workspaces/${session.sessionId}/shells/${shellId}`, user);
    expect(killed.ok()).toBe(true);

    await expect(paneBarFor(windowA, 'probe-alpha')).toHaveCount(0, { timeout: 30_000 });
    await expect(paneBarFor(windowB, 'probe-alpha')).toHaveCount(0, { timeout: 30_000 });
    await expect(windowA.getByTestId(PANE_BAR)).toHaveCount(paneCount - 1, { timeout: 30_000 });
    await expect(windowB.getByTestId(PANE_BAR)).toHaveCount(paneCount - 1, { timeout: 30_000 });

    // And it is DURABLE, not merely a message both windows received: the pane
    // is gone from the ROWS, which is where the expel actually landed.
    const nodes = await readNodes(request, user, session.sessionId);
    expect(nodes.filter((node) => node.nodeType === 'pane')).toHaveLength(paneCount - 1);
  });

  test('closing the pane of a shell that is already gone raises NO error toast (#2473)', async ({
    browser,
    baseURL,
    request,
  }) => {
    const user = await seedUser();
    const session = await createSession(request, user);
    await seedSessionShell(session.sessionId, user.userId, 'keeper');
    const shellId = await seedSessionShell(session.sessionId, user.userId, 'probe-ghost');

    // A second shell for the same reason as above: the pane being closed must
    // not be the last one, or the close raises the end-session confirm instead.
    const windowA = await openGridWindow(browser, user, baseURL!, session);
    await openShellFromSidebar(windowA, session.sessionId, 'keeper');
    await openShellFromSidebar(windowA, session.sessionId, 'probe-ghost');
    await expect(paneBarFor(windowA, 'probe-ghost')).toHaveCount(1, { timeout: 30_000 });

    // The row goes WITHOUT the route — the state a user reaches when the shell
    // went with an ended session, or when they clicked Close twice. The pane is
    // still on screen, and closing it will DELETE a shell that is not there.
    await removeSessionShell(shellId);

    // WAIT FOR THE 404 ITSELF, not just for the pane to go. The pane closes
    // optimistically and instantly; the toast — the thing under test — can only
    // be raised by the DELETE's rejection, which lands later. Asserting silence
    // before the answer arrives would pass no matter what the client did with
    // it (this suite did exactly that, and stayed green under a mutation that
    // restored the toast).
    const [answer] = await Promise.all([
      windowA.waitForResponse(
        (response) => response.url().includes(`/shells/${shellId}`) && response.request().method() === 'DELETE',
      ),
      paneBarFor(windowA, 'probe-ghost').getByRole('button', { name: 'Close pane' }).click(),
    ]);
    expect(answer.status()).toBe(404);

    await expect(paneBarFor(windowA, 'probe-ghost')).toHaveCount(0, { timeout: 30_000 });
    // THE ASSERTION. The route's own doc has always said a 404 here is success;
    // the client used to toast anyway. The pause is the honest way to assert
    // that something did NOT happen: the rejection is already in hand, so a
    // toast would have been rendered within it.
    await windowA.waitForTimeout(1_500);
    // COUNTED ONCE, not asserted with a retrying matcher. `expect(locator)
    // .toHaveCount(0)` retries until it passes, and a sonner toast dismisses
    // itself after four seconds — so the retrying form goes green on the
    // toast's own timeout and reports nothing at all. It did: this suite passed
    // under a mutation that restored the toast, twice, before the count was
    // taken by value.
    expect(await windowA.locator('[data-sonner-toast]').count()).toBe(0);
  });

  test('opening several shells PACKS them into a grid rather than a row of columns (#2469)', async ({
    browser,
    baseURL,
    request,
  }) => {
    const user = await seedUser();
    const session = await createSession(request, user);
    for (const name of ['pack-1', 'pack-2', 'pack-3', 'pack-4']) {
      await seedSessionShell(session.sessionId, user.userId, name);
    }

    const windowA = await openGridWindow(browser, user, baseURL!, session);
    for (const name of ['pack-1', 'pack-2', 'pack-3', 'pack-4']) {
      await openShellFromSidebar(windowA, session.sessionId, name);
      await expect(paneBarFor(windowA, name)).toHaveCount(1, { timeout: 30_000 });
    }

    const nodes = await readNodes(request, user, session.sessionId);
    const panes = nodes.filter((node) => node.nodeType === 'pane');
    expect(panes.length).toBeGreaterThanOrEqual(4);

    // A ROW OF COLUMNS is what this used to be: every split took the `row`
    // default, so the root ended up holding one child per shell and each pane
    // was a sliver. A packed grid divides in both directions.
    const containers = nodes.filter((node) => node.nodeType === 'split' || node.nodeType === 'root');
    expect(containers.some((node) => node.axis === 'column')).toBe(true);

    // And it stayed shallow. Under the old rule each open nested one container
    // deeper into the pane the user was looking at, walking toward MAX_DEPTH.
    expect(deepestPane(nodes)).toBeLessThanOrEqual(3);
  });
});

