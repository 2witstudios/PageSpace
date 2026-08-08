import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { seedUser, type SeededUser } from '../support/db';
import { sessionPost, sessionDelete } from '../support/http';
import { authedContext } from '../fixtures/chat.fixture';

/**
 * # A server-created conversation reaches the SIDEBAR, off the directory plane, not off a poll
 *
 * The user story: **a worker spawned server-side appears in your sidebar without
 * you waiting for a poll tick.** Before the directory plane it took up to a poll
 * interval, which is why "did that actually work?" was a question at all.
 *
 * ## Why this spec exists when the pieces were already tested
 *
 * Both ends of the seam were already proven, and the middle was not:
 *
 *  - the SERVER end — the directory events really are emitted to the owner's
 *    `user:<id>:sessions` room on a session-scoped create
 *    (`conversation-created-emit.integration.test.ts`);
 *  - the CLIENT end — the listener really does apply them to the session
 *    listing cache (`session-directory-listener.test.ts`).
 *
 * What nothing asserted is that the key the listener mutates is the key
 * `AgentsSidebar` subscribes to. That held BY CONSTRUCTION only, and by a
 * construction with a real fault line in it: the listener writes through the
 * `isWorkspaceListingKey` / `isAgentWorkspacesKey` PREDICATES
 * (`session-conversations.ts`), while the sidebar builds its key as an inline
 * template string rather than calling the shared `agentWorkspacesKey()` helper.
 * `AgentsSidebar.test.tsx` cannot see that — it feeds SWR data in directly and
 * contains nothing socket-driven. So the seam could break and the symptom would
 * be a sidebar that still works, just slowly, off the 120s backstop poll. That
 * is the failure this spec exists to make loud.
 *
 * ## What writing it revealed, and why the two tests are shaped differently
 *
 * The obvious spec — block the listing GET outright, spawn, assert the row
 * appears — DOES NOT PASS, and it is right not to. Creation and session-binding
 * are decoupled on purpose (`create-conversation-in-workspace.ts`: a sessionless
 * conversation is an ordinary state), so the sequence on this path is:
 *
 *   1. `conversation:created` fires for a row that is not yet in any session,
 *      i.e. with `workspaceId: null` — and the listener correctly declines to
 *      insert it into a session listing, because it is not in one yet;
 *   2. the claim lands and `conversation:updated { workspaceId }` fires, which
 *      the listener answers with `revalidateWorkspaceListings` — a REFETCH,
 *      deliberately, because a re-binding moves a row between sessions and the
 *      listing query owns that predicate.
 *
 * So on the spawn path the sidebar is updated by ONE EVENT-DRIVEN REQUEST, not
 * by a request-free cache write. That is still the guarantee — event-driven, not
 * a poll — but it is not the stronger thing "with no request" would claim, and
 * the `upsertConversationInCache` branch is not what serves this story.
 *
 * Hence two tests:
 *
 *  - **the user story**, which cannot block the network (the refetch is the
 *    mechanism) and instead rules the poll out with a CONTROL: a quiet period
 *    of the same length as the assertion window, asserted to contain zero
 *    listing fetches. A bare "20s assertion, 120s poll" argument rots silently
 *    when someone demotes the interval; this one FAILS LOUDLY, because the
 *    control period would see the tick.
 *  - **the seam at its strongest**, on the CLOSE event, which really is a
 *    request-free local write (`forgetConversationInCache`, `revalidate: false`).
 *    There the listing GET is aborted at the network layer for the whole
 *    assertion window, so nothing but the socket applying to the sidebar's own
 *    SWR key can move the list. `data` from before the block survives (SWR keeps
 *    the last successful value, and the sidebar's error branch only fires on an
 *    EMPTY list), so the surface stays the one under test.
 *
 * ## Topology
 *
 * Same as `16-dispatch-multiplayer.spec.ts`, and required for the same reason:
 * realtime must be reachable SAME-ORIGIN (a proxy forwarding `/socket.io`, with
 * `NEXT_PUBLIC_REALTIME_URL` unset), because the shipped CSP is
 * `connect-src 'self' ws: wss:` and Socket.IO's opening XHR handshake to
 * another origin is blocked outright — no socket, no rooms. See that file's
 * header, and the `e2e` job in `.github/workflows/ci.yml`. This spec does NOT
 * set `bypassCSP`: it would relax the exact policy the topology exists to
 * respect.
 *
 * TWO sessions, and which one is which matters. Session A is opened in the pane
 * grid, only so the console is genuinely live. Session B — the one under test —
 * is NEVER opened.
 *
 * That asymmetry used to be load-bearing for a second reason: the sidebar
 * rendered PANE rows for a session with a grid and the flat conversation list
 * for one without, and only the latter carried `sidebar-conversation-row` — so
 * Session B had to be grid-less for this spec to see anything at all. That fork
 * was the cause of issue #2373 and is gone: there is one row shape now, every
 * row carries the testId, and these assertions hold whether or not a session has
 * a grid. Session B stays unopened only because an unopened session is the
 * honest test of a DIRECTORY event — nothing about it is being rendered by a
 * pane surface that might refetch on its own.
 */

// The shared storageState user belongs to a drive this spec does not control;
// seed our own, exactly as the dispatch and grid specs do. Also keeps the spec
// order-independent under `workers: 1`.
test.use({ storageState: { cookies: [], origins: [] } });

// Booting the agents console is a production build, an auth round trip, a
// listing fetch and a socket handshake before anything is assertable. The
// per-assertion ceilings below stay the failure surface; passing runs are far
// under this.
test.setTimeout(120_000);

const SESSION_PANES = 'session-panes';
const PANE_BAR = 'pane-bar';
const CONVERSATION_ROW = 'sidebar-conversation-row';

/** The bulk session-listing endpoint — NOT its per-session sub-resources. */
const LISTING_PATHNAME = '/api/agent-workspaces';

/**
 * Wide enough that the left sidebar is a PERSISTENT panel rather than an
 * overlay sheet. `Layout.tsx` overlays it under `(max-width: 1279px)`, and the
 * Desktop Chrome device preset is exactly 1280 — sitting on the boundary of the
 * one media query that decides whether the surface under test is on screen at
 * all. Stated explicitly so a preset change cannot silently turn this spec into
 * a test of the mobile sheet.
 */
const DESKTOP_VIEWPORT = { width: 1600, height: 1000 };

/**
 * The quiet-period control AND the assertion ceiling — deliberately the same
 * number, because that is what makes the control mean anything: observing zero
 * listing fetches in a window of length N is only evidence about a later window
 * of length N. Comfortably under the sidebar's 120s `refreshInterval`, and
 * comfortably over the sub-second the directory plane actually takes.
 */
const POLL_CONTROL_MS = 10_000;

// Closed in teardown, never inline, so a failing assertion cannot leak one.
const openContexts: BrowserContext[] = [];

test.afterEach(async () => {
  await Promise.all(openContexts.map((context) => context.close()));
  openContexts.length = 0;
});

/**
 * Mint a session through the front door. `{ driveId }` with no `firstThing` is
 * the assistant-first shape: the session plus its opening conversation, and NO
 * sandbox — a real Sprite would make this spec slow and infrastructure-bound
 * for a question about cache keys.
 */
async function createSession(
  request: APIRequestContext,
  user: SeededUser,
  name: string,
): Promise<{ sessionId: string; conversationId: string }> {
  const response = await sessionPost(request, '/api/agent-workspaces', user, {
    driveId: user.driveId,
    name,
  });
  if (!response.ok()) {
    throw new Error(
      `createSession(${name}): POST /api/agent-workspaces answered ${response.status()}: ${(await response.text()).slice(0, 500)}`,
    );
  }
  const body = (await response.json()) as { session: { workspaceId: string }; conversationId: string };
  return { sessionId: body.session.workspaceId, conversationId: body.conversationId };
}

/**
 * Start a conversation inside an existing session FROM OUTSIDE THE BROWSER —
 * Playwright's API context is a different HTTP client than the page under test,
 * so the page has no optimistic write, no pending request and no local
 * knowledge of this conversation. Exactly the shape of a worker an agent spawns
 * on the user's behalf: the browser can only learn about it by being told.
 */
async function spawnConversationServerSide(
  request: APIRequestContext,
  user: SeededUser,
  sessionId: string,
): Promise<string> {
  const response = await sessionPost(
    request,
    `/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations`,
    user,
    // `null` is the global assistant — the one counterpart that needs no agent
    // page, so this spec does not have to seed and permission one.
    { agentPageId: null },
  );
  if (!response.ok()) {
    throw new Error(
      `spawnConversationServerSide: answered ${response.status()}: ${(await response.text()).slice(0, 500)}`,
    );
  }
  return ((await response.json()) as { conversationId: string }).conversationId;
}

/** Close a conversation out of its session, again from outside the browser. */
async function closeConversationServerSide(
  request: APIRequestContext,
  user: SeededUser,
  sessionId: string,
  conversationId: string,
): Promise<void> {
  const response = await sessionDelete(
    request,
    `/api/agent-workspaces/${encodeURIComponent(sessionId)}/conversations/${encodeURIComponent(conversationId)}`,
    user,
  );
  if (!response.ok()) {
    throw new Error(
      `closeConversationServerSide: answered ${response.status()}: ${(await response.text()).slice(0, 500)}`,
    );
  }
}

/**
 * Count session-listing GETs from now on, without interfering with them — the
 * observational half, used for the poll CONTROL.
 *
 * `page.on('request')` sees requests that `page.route` cannot (see the Service
 * Worker note in `openConsole`), and here we want to observe rather than block,
 * so this is the right instrument for the control and `blockSessionListingFetches`
 * is the right one for the seam test.
 */
function countSessionListingFetches(page: Page): () => number {
  let seen = 0;
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === LISTING_PATHNAME) seen++;
  });
  return () => seen;
}

/**
 * Cut the session-listing fetch off at the network layer, and report how many
 * attempts were made.
 *
 * THIS IS THE ASSERTION'S TEETH, so it is worth saying what it must and must
 * not catch. `isWorkspaceListingKey`'s two keys are exactly `/api/agent-workspaces`
 * and `/api/agent-workspaces?...`; `/api/agent-workspaces/<id>` and
 * `/api/agent-workspaces/<id>/shells` are different cache entries (the latter on
 * a 15s poll) that this spec has no business blocking. So the match is an exact
 * PATHNAME equality, expressed as a URL PREDICATE rather than a glob — a
 * `'**\/api/agent-workspaces**'` glob silently matched nothing here, and a
 * matcher that quietly matches nothing turns this whole spec into a tautology
 * that passes off the very refetch it claims to have ruled out. Confirmed
 * against the failure case: with the socket seam severed this counter goes
 * non-zero and the spec fails.
 *
 * WHY BLOCKING IS NECESSARY AT ALL, since it looks like belt-and-braces on a
 * passing run: `conversation:created` is not the only directory event a
 * session-scoped create produces, and the others (`session:*`, a
 * `conversation:updated` carrying a workspace binding) deliberately answer with
 * `revalidateWorkspaceListings` — a REFETCH. That refetch also puts the row on
 * screen, so without this block the spec would go green with the listener's
 * cache write removed entirely. Verified: it did.
 */
async function blockSessionListingFetches(page: Page): Promise<() => number> {
  let attempts = 0;
  await page.route(
    (url) => url.pathname === LISTING_PATHNAME,
    async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      attempts++;
      await route.abort();
    },
  );
  return () => attempts;
}

/**
 * Everything both specs need before they can assert anything: two sessions, a
 * logged-in window with the agents console live on the first, and a socket
 * proven to be connected.
 */
async function openConsole(
  browser: Parameters<typeof authedContext>[0],
  baseURL: string,
  request: APIRequestContext,
): Promise<{
  user: SeededUser;
  page: Page;
  displayed: { sessionId: string; conversationId: string };
  target: { sessionId: string; conversationId: string };
}> {
  const user = await seedUser();
  // Session A is opened in the grid; session B is the one under test and is
  // never opened, so it keeps `workspace: null` in the listing. That used to
  // decide WHICH row shape the sidebar rendered; since issue #2373 there is
  // only one, and B stays unopened because an unopened session is the honest
  // test of a DIRECTORY event — no pane surface of its own to refetch.
  const displayed = await createSession(request, user, 'displayed session');
  const target = await createSession(request, user, 'target session');

  // `serviceWorkers: 'block'` is REQUIRED, not tidiness. The app registers
  // `/sw.js` (`app/layout.tsx`), and Playwright's request interception cannot
  // see a fetch that goes through a Service Worker — so with one installed,
  // `blockSessionListingFetches` silently intercepts NOTHING: zero attempts
  // counted, every refetch sailing through, and the spec passing off the very
  // request it claims to have ruled out. That is not hypothetical; it is what
  // this spec did until the severed-seam run refused to fail. Blocking the
  // worker also removes it as a second, uncontrolled cache between the app and
  // the assertion, which is worth having regardless.
  const context = await authedContext(browser, user.sessionToken, baseURL, {
    serviceWorkers: 'block',
  });
  openContexts.push(context);
  const page = await context.newPage();
  await page.setViewportSize(DESKTOP_VIEWPORT);

  // Armed BEFORE navigation: the handshake starts during the first paint, so a
  // listener attached afterwards can miss it entirely. A websocket existing
  // means Socket.IO's polling handshake already completed, and the personal
  // rooms — `user:<id>:sessions` among them — are joined AT CONNECT, server
  // side, with no subscribe call. So this is the readiness signal for "the
  // directory plane can reach this page", which the assertions below would
  // otherwise be silently racing.
  const socketConnected = page.waitForEvent('websocket', { timeout: 60_000 });

  await page.goto(
    `/dashboard/${user.driveId}/agents?workspace=${displayed.sessionId}&c=${displayed.conversationId}`,
  );
  await page.getByTestId(SESSION_PANES).waitFor({ state: 'visible', timeout: 60_000 });
  await expect(page.getByTestId(PANE_BAR)).toHaveCount(1, { timeout: 60_000 });
  await socketConnected;

  return { user, page, displayed, target };
}

/**
 * Expand a session's row — a purely local disclosure toggle (`setExpanded`), no
 * fetch — and return a locator for its conversation rows, scoped to that
 * session's own subtree so nothing depends on which other rows are expanded.
 */
async function expandSession(page: Page, sessionId: string) {
  const row = page.getByTestId(`sidebar-session-${sessionId}`);
  await row.waitFor({ state: 'visible', timeout: 60_000 });
  await row.getByRole('button', { name: /^Expand / }).click();
  return { row, conversationRows: row.getByTestId(CONVERSATION_ROW) };
}

test.describe('session directory — a server-created conversation reaches the sidebar', () => {
  test('a server-spawned conversation reaches the sidebar off the directory plane, not off the backstop poll', async ({
    browser,
    baseURL,
    request,
  }) => {
    const { user, page, target } = await openConsole(browser, baseURL!, request);

    const { conversationRows } = await expandSession(page, target.sessionId);
    // The session's opening conversation, and only it. Pinning the count is
    // what makes the assertion below a CHANGE rather than a coincidence.
    await expect(conversationRows).toHaveCount(1, { timeout: 30_000 });

    // THE CONTROL, and the thing that makes this more than a timing argument.
    // Sit still for exactly as long as the assertion below is allowed to take,
    // and require that the sidebar asked for NOTHING in that time. That is a
    // measured fact about this build's poll behaviour, not an assumption about
    // it: demote the 120s `refreshInterval` back to 20s and this fails here,
    // loudly, instead of letting the assertion pass for the wrong reason.
    const listingFetches = countSessionListingFetches(page);
    await page.waitForTimeout(POLL_CONTROL_MS);
    expect(
      listingFetches(),
      'the sidebar polled during the control window — the poll is now fast enough to be ' +
      'what makes the assertion below pass, so this spec no longer proves the directory ' +
      'plane delivered anything. Re-establish the separation before trusting it.',
    ).toBe(0);

    const quietFetches = listingFetches();
    const spawnedConversationId = await spawnConversationServerSide(request, user, target.sessionId);
    expect(spawnedConversationId).toBeTruthy();

    // THE ASSERTION. A window this length was just shown to contain no poll, so
    // a row appearing in one can only have come from the directory events the
    // spawn produced — reaching the SWR key `AgentsSidebar` itself subscribes
    // to. Diverge that key from the listener's predicates and the count stays
    // at 1 until the 120s backstop, long past this timeout.
    await expect(conversationRows).toHaveCount(2, { timeout: POLL_CONTROL_MS });

    // …and it was EVENT-driven work, not a coincidence of an idle client: the
    // claim's `conversation:updated { workspaceId }` is answered with
    // `revalidateWorkspaceListings`, so the spawn must have caused listing
    // traffic that the quiet window did not have. Without this, a spec that
    // somehow rendered the row from nothing would still read as green.
    expect(listingFetches()).toBeGreaterThan(quietFetches);
  });

  /**
   * The seam at its strongest: a directory event that needs NO request at all.
   *
   * `conversation:closed` is answered by `forgetConversationInCache` — a local
   * `mutate(isWorkspaceListingKey, updater, { revalidate: false })`. So here the
   * listing GET can be cut off at the network layer for the whole assertion
   * window, and the list still has to move. Nothing but the listener's write
   * landing on the sidebar's own SWR key can do that; a key that drifted out of
   * `isWorkspaceListingKey`'s namespace leaves the row on screen forever.
   *
   * This is also the direction the spawn path cannot test, because create and
   * claim are decoupled — see the file header.
   */
  test('a server-side close removes the row with the listing fetch cut off at the network', async ({
    browser,
    baseURL,
    request,
  }) => {
    const { user, page, target } = await openConsole(browser, baseURL!, request);

    const { conversationRows } = await expandSession(page, target.sessionId);
    await expect(conversationRows).toHaveCount(1, { timeout: 30_000 });

    // A SECOND conversation, so the close below is an ordinary close rather
    // than a collision with the never-empty invariant (the server refuses to
    // close a session's last open listing with a 409).
    const spawned = await spawnConversationServerSide(request, user, target.sessionId);
    await expect(conversationRows).toHaveCount(2, { timeout: POLL_CONTROL_MS });

    // From here the listing cannot be re-read at all.
    const blockedFetches = await blockSessionListingFetches(page);

    await closeConversationServerSide(request, user, target.sessionId, spawned);

    // THE ASSERTION. The browser never asked and cannot ask; the row can only
    // have left because `conversation:closed` → `forgetConversationInCache` →
    // the sidebar's own SWR key.
    await expect(conversationRows).toHaveCount(1, { timeout: POLL_CONTROL_MS });

    // Diagnostic, not an assertion — a non-zero count means something still
    // WANTED to refetch and was denied, which is worth knowing when the 120s
    // backstop is finally deleted.
    // eslint-disable-next-line no-console -- surfaced in the Playwright report, not app code
    console.log(`listing fetches blocked during the close window: ${blockedFetches()}`);
  });

  /**
   * The opposite error to the two above: a listener that inserted into EVERY
   * session's row rather than the spawning one would keep a target-scoped count
   * green. That is the mistake `upsertConversationInCache`'s
   * `session.sessionId !== sessionId` guard — and the listing query behind the
   * refetch — exist to prevent.
   */
  test('the row lands in the spawning session only, not in every session listing', async ({
    browser,
    baseURL,
    request,
  }) => {
    const { user, page, displayed, target } = await openConsole(browser, baseURL!, request);

    // Expand BOTH, so a stray insert into the bystander would be VISIBLE rather
    // than hidden behind a collapsed row.
    const { conversationRows } = await expandSession(page, target.sessionId);
    const { conversationRows: bystanderRows } = await expandSession(page, displayed.sessionId);
    await expect(conversationRows).toHaveCount(1, { timeout: 30_000 });

    // The bystander's own count BEFORE the spawn. Asserting "unchanged" rather
    // than "zero" is what makes this test about leakage rather than about a
    // render branch (issue #2373).
    //
    // It used to read `toHaveCount(0)`, and the reason was structural: the
    // displayed session has a persisted grid, so the sidebar rendered PANE rows
    // for it — and only the conversation branch carried
    // `sidebar-conversation-row`, so its threads were invisible to this
    // selector. Both facts are now gone: there is one row shape, every row
    // carries the testId, and a session's own threads legitimately count. Zero
    // would now fail for a reason that has nothing to do with leakage.
    //
    // Settle it FIRST. `count()` takes a snapshot and does not auto-retry, so
    // reading it mid-render would capture 0, and the auto-retrying assertion
    // below would then fail the moment the bystander's own row arrived —
    // flaky, and for the opposite reason to the one under test. One row,
    // because `createSession` gives each session exactly one conversation.
    await expect(bystanderRows).toHaveCount(1, { timeout: 30_000 });
    const bystanderBefore = await bystanderRows.count();

    await spawnConversationServerSide(request, user, target.sessionId);
    await expect(conversationRows).toHaveCount(2, { timeout: POLL_CONTROL_MS });

    // THE ASSERTION: the spawn moved the target's list and left the bystander's
    // alone. A listener that inserted into every session — the mistake
    // `upsertConversationInCache`'s `session.sessionId !== sessionId` guard
    // exists to prevent — would move this too.
    await expect(bystanderRows).toHaveCount(bystanderBefore);
  });
});
