import { test, expect } from '@playwright/test';
import { seedUser, seedChannel, addDriveMember } from '../support/db';
import { sessionPost } from '../support/http';
import { authedContext } from '../fixtures/chat.fixture';

/**
 * # The Channels count moves when someone posts, without a reload
 *
 * The user story: **a message in a channel you belong to raises the number beside
 * "Channels" while you are looking at something else.** Before this, the badge
 * counted unread @mentions only, so an ordinary message left it at zero.
 *
 * ## Why this spec exists when the pieces were already tested
 *
 * Both ends of the seam are proven, and the middle was not:
 *
 *  - the SERVER end — the recipient set really does include an ordinary accepted
 *    member of a non-private channel, against a real database
 *    (`page-viewers.integration.test.ts`), and the badge query really does count
 *    watermark-unread messages (`api/sidebar/badges/__tests__/route.test.ts`);
 *  - the CLIENT end — the hook really does subscribe to `inbox:channel_updated`
 *    and revalidate on it (`useSidebarBadges.test.ts`).
 *
 * What nothing asserted is that a real post travels the whole way: POST → fan-out
 * → `notifications:<userId>` room → the socket this browser actually holds → SWR
 * → the rendered number. Every link in that chain is a string or a room name
 * matched by convention, and a typo in any of them fails silently — the badge
 * simply never moves, which looks identical to "no unread". This spec is the one
 * thing that fails loudly when that happens.
 *
 * It is also the regression the fan-out fix was for: the recipient here is a
 * plain MEMBER with no page_permissions row and no admin role, which is exactly
 * the user the previous hand-written recipient query dropped.
 *
 * ## Ruling out the poll
 *
 * "The number appeared" is not by itself evidence of the socket — a refetch on an
 * interval would look the same. So the first test counts requests to
 * `/api/sidebar/badges` and asserts a CONTROL: a quiet period, of the same length
 * as the assertion window, in which the badge endpoint is not hit at all. If
 * someone later adds a `refreshInterval` to the hook, that control fails and says
 * so, rather than this spec quietly degrading into a poll test.
 *
 * ## Topology
 *
 * Same as `16-dispatch-multiplayer.spec.ts` and `18-sidebar-directory-live.spec.ts`,
 * and required for the same reason: realtime must be reachable SAME-ORIGIN, because
 * the shipped CSP is `connect-src 'self' ws: wss:` and Socket.IO's opening XHR
 * handshake to another origin is blocked outright — no socket, no rooms. See the
 * `e2e` job in `.github/workflows/ci.yml`.
 */

const BADGE = 'nav-badge-channels';
const BADGE_ENDPOINT = '/api/sidebar/badges';

/** Long enough for the 250ms debounce plus a refetch, short enough to stay a test. */
const APPEAR_TIMEOUT = 20_000;
/** The control window. Same length as the one the assertion gets. */
const QUIET_MS = APPEAR_TIMEOUT;

/**
 * Wait until the badge-endpoint request count stops moving, so the control window
 * measures steady state rather than the tail of mount.
 */
async function waitForFetchesToSettle(count: () => number, stableForMs = 2_000): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last = count();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const now = count();
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableForMs) {
      return;
    }
  }
}

test.describe('Channels badge, live', () => {
  test('counts a message posted while the reader is on another page, with no reload', async ({
    browser,
    request,
    baseURL,
  }) => {
    const poster = await seedUser();
    const reader = await seedUser();
    // A plain accepted member: no admin role, no explicit page grant. This is the
    // exact principal the old fan-out query failed to notify.
    await addDriveMember(poster.driveId, reader.userId);
    const channelId = await seedChannel(poster.driveId);

    const context = await authedContext(browser, reader.sessionToken, baseURL!);
    const page = await context.newPage();

    let badgeFetches = 0;
    page.on('request', (req) => {
      if (req.url().includes(BADGE_ENDPOINT)) badgeFetches += 1;
    });

    // The reader sits in their OWN drive, never opening the channel — the badge is
    // user-wide, so a message in a drive they merely belong to must still count.
    await page.goto(`/dashboard/${reader.driveId}`);
    await expect(page.getByTestId(BADGE)).toHaveCount(0);

    // Let mount settle before measuring. The hook fetches twice on mount — SWR's own
    // fetch plus the effect watching the notification store's unread count — and both
    // land together a few hundred ms in. Snapshotting before they arrive would count
    // startup as a poll, which is what the first draft of this control did.
    await waitForFetchesToSettle(() => badgeFetches);
    const fetchesAfterLoad = badgeFetches;

    // CONTROL: nothing arrives, so nothing should refetch. A poll would show up here.
    // Measured while writing this: over 60s idle the endpoint is hit exactly twice,
    // both at ~365ms, and never again — there is no interval to accommodate.
    await page.waitForTimeout(QUIET_MS);
    expect(
      badgeFetches,
      'the badge endpoint was refetched during a quiet period — this spec can no longer tell a socket update from a poll',
    ).toBe(fetchesAfterLoad);
    await expect(page.getByTestId(BADGE)).toHaveCount(0);

    const res = await sessionPost(request, `/api/channels/${channelId}/messages`, poster, {
      content: 'anyone around?',
    });
    expect(res.status(), await res.text()).toBe(201);

    await expect(page.getByTestId(BADGE)).toHaveText('1', { timeout: APPEAR_TIMEOUT });

    await context.close();
  });

  test('clears when the reader opens the channel', async ({ browser, request, baseURL }) => {
    const poster = await seedUser();
    const reader = await seedUser();
    await addDriveMember(poster.driveId, reader.userId);
    const channelId = await seedChannel(poster.driveId);

    const context = await authedContext(browser, reader.sessionToken, baseURL!);
    const page = await context.newPage();
    await page.goto(`/dashboard/${reader.driveId}`);

    await sessionPost(request, `/api/channels/${channelId}/messages`, poster, {
      content: 'first',
    });
    await expect(page.getByTestId(BADGE)).toHaveText('1', { timeout: APPEAR_TIMEOUT });

    // Opening the channel advances the read watermark, which broadcasts
    // inbox:read_status_changed back to this same reader and clears the count.
    await page.goto(`/dashboard/${poster.driveId}/${channelId}`);
    await expect(page.getByTestId(BADGE)).toHaveCount(0, { timeout: APPEAR_TIMEOUT });

    await context.close();
  });

  test('does not count a channel the reader cannot see', async ({ browser, request, baseURL }) => {
    const poster = await seedUser();
    const outsider = await seedUser();
    // Deliberately NOT a member of the poster's drive.
    const channelId = await seedChannel(poster.driveId);

    const context = await authedContext(browser, outsider.sessionToken, baseURL!);
    const page = await context.newPage();
    await page.goto(`/dashboard/${outsider.driveId}`);

    await sessionPost(request, `/api/channels/${channelId}/messages`, poster, {
      content: 'private business',
    });

    // Give it the same window the positive case gets, so this is a real negative
    // rather than a race that happens to pass.
    await page.waitForTimeout(APPEAR_TIMEOUT);
    await expect(page.getByTestId(BADGE)).toHaveCount(0);

    await context.close();
  });
});
