import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { provisionHomeDriveIfNeeded } from '@pagespace/lib/onboarding/home-drive';
import { seedUser, type SeededUser } from '../support/db';
import { deleteUsers } from '../fixtures/imago.fixture';

/**
 * # Imago dev /api proxy — same-origin cookies and CSRF against a running web (IMG-1.3)
 *
 * apps/imago's `next dev` rewrites `/api/*` (outside its `/imago` basePath) to apps/web at
 * `WEB_APP_INTERNAL_URL`, so the browser on the imago origin calls `/api` same-origin and the
 * `session` cookie rides along exactly as in production. The rewrite forwards the browser's
 * `Origin` header verbatim, so apps/web's origin validation sees the IMAGO origin — which it
 * accepts only once `ADDITIONAL_ALLOWED_ORIGINS` lists it (apps/web/.env.example).
 *
 * Every request here goes through the imago dev server, never to web directly: a pass proves
 * the rewrite, web's CSRF minting and web's origin validation together.
 *
 * ## Requires
 *
 *  - apps/web running with `ADDITIONAL_ALLOWED_ORIGINS` including the imago origin, and
 *    `ORIGIN_VALIDATION_MODE` unset or `block`.
 *  - apps/imago running under `next dev` (`bun run dev`) with `WEB_APP_INTERNAL_URL` pointing
 *    at that web, reachable at `IMAGO_DEV_URL` (default http://localhost:3006).
 *
 * Start web WITHOUT the imago origin in `ADDITIONAL_ALLOWED_ORIGINS` and the first test fails
 * with 403 ORIGIN_INVALID: that is the "rejected without it" half of the criterion.
 *
 * ## Hydration under `next dev` (IMG-1.2a)
 *
 * React's development build needs eval, so imago's CSP adds 'unsafe-eval' to script-src under
 * `next dev` only. The last describe block opens /imago on the dev server in a real browser and
 * proves the shell hydrates: the shell marks itself data-hydrated, and clicking a rail link navigates on the
 * client (a JS property tagged on the rail survives, which a document load cannot keep). That
 * needs the dev server started with `IMAGO_ENABLED=true`. Drop the dev rule from
 * apps/imago/src/middleware/security-headers.ts and it fails: Chromium reports
 * `'unsafe-eval' is not an allowed source` and the shell never marks itself hydrated.
 */

const IMAGO_DEV_URL = process.env.IMAGO_DEV_URL ?? 'http://localhost:3006';
const IMAGO_ORIGIN = new URL(IMAGO_DEV_URL).origin;
const UNLISTED_ORIGIN = 'https://not-allowed.example';

// An idempotent, DB-only mutation behind session auth + CSRF + origin validation.
const MUTATION_PATH = '/api/notifications/read-all';

const imagoUrl = (apiPath: string): string => new URL(apiPath, IMAGO_DEV_URL).toString();

test.describe('imago dev /api proxy', () => {
  let user: SeededUser;

  test.beforeAll(async () => {
    user = await seedUser();
  });

  test.afterAll(async () => {
    await deleteUsers([user.userId]);
  });

  /** The CSRF token, minted by web through the imago proxy for this session. */
  const csrfViaImago = async (request: APIRequestContext): Promise<string> => {
    const response = await request.get(imagoUrl('/api/auth/csrf'), {
      headers: { cookie: `session=${user.sessionToken}` },
    });
    expect(response.status(), 'GET /api/auth/csrf through the imago proxy').toBe(200);
    const body: unknown = await response.json();
    expect(body).toEqual({ csrfToken: expect.any(String) });
    return (body as { csrfToken: string }).csrfToken;
  };

  const patchViaImago = (request: APIRequestContext, headers: Record<string, string>) =>
    request.patch(imagoUrl(MUTATION_PATH), {
      headers: { cookie: `session=${user.sessionToken}`, ...headers },
      maxRedirects: 0,
    });

  test('a mutation from the imago origin with a valid CSRF token passes web origin validation', async ({
    request,
  }) => {
    const csrfToken = await csrfViaImago(request);

    const response = await patchViaImago(request, {
      origin: IMAGO_ORIGIN,
      'x-csrf-token': csrfToken,
    });

    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toEqual({ success: true });
  });

  test('negative control: the same mutation from an unlisted origin is rejected', async ({
    request,
  }) => {
    const csrfToken = await csrfViaImago(request);

    const response = await patchViaImago(request, {
      origin: UNLISTED_ORIGIN,
      'x-csrf-token': csrfToken,
    });

    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'ORIGIN_INVALID' });
  });

  test('negative control: the imago origin without a valid CSRF token is rejected', async ({
    request,
  }) => {
    const response = await patchViaImago(request, {
      origin: IMAGO_ORIGIN,
      'x-csrf-token': 'not-a-csrf-token',
    });

    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'CSRF_TOKEN_INVALID' });
  });
});

type Probed = HTMLElement & { __probe?: string };

const railLink = (page: Page, name: string): Locator =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name, exact: true });

test.describe('imago under next dev in a browser', () => {
  let user: SeededUser;
  let homeDriveId: string;

  test.beforeAll(async () => {
    user = await seedUser();
    ({ driveId: homeDriveId } = await provisionHomeDriveIfNeeded(user.userId));
  });

  test.afterAll(async () => {
    await deleteUsers([user.userId]);
  });

  test('/imago hydrates and navigates on the client', async ({ browser }) => {
    // The dev server compiles the shell on its first request.
    test.setTimeout(120_000);
    // Its own context: the suite's storageState belongs to the proxy origin's user.
    const context = await browser.newContext({ storageState: undefined });
    await context.addCookies([{ name: 'session', value: user.sessionToken, url: IMAGO_DEV_URL }]);
    const page = await context.newPage();
    const evalBlocked: string[] = [];
    page.on('pageerror', (error) => {
      if (error.message.includes('unsafe-eval')) evalBlocked.push(error.message);
    });
    page.on('console', (message) => {
      if (message.text().includes('unsafe-eval')) evalBlocked.push(message.text());
    });

    try {
      const response = await page.goto(new URL('/imago', IMAGO_DEV_URL).toString());
      const csp = response?.headers()['content-security-policy'] ?? '';
      expect(csp, 'the dev server serves the development CSP').toContain("'unsafe-eval'");

      await page.waitForURL((url) => url.pathname === `/imago/${homeDriveId}`);
      const files = railLink(page, 'Files');
      await expect(files).toBeVisible();

      // Server-rendered markup is visible before hydration; the shell says when React has it.
      await expect(page.locator('[data-section][data-hydrated]')).toHaveCount(1, { timeout: 60_000 });
      const rail = page.getByRole('navigation', { name: 'Primary' });
      await rail.evaluate((node) => {
        (node as Probed).__probe = 'rail';
      });

      await files.click();
      await page.waitForURL((url) => url.pathname === `/imago/${homeDriveId}/files`);
      await expect(page.locator('[data-section]')).toHaveAttribute('data-section', 'files');
      expect(
        await rail.evaluate((node) => (node as Probed).__probe ?? null),
        'the rail survives a client navigation',
      ).toBe('rail');
      expect(evalBlocked, 'no eval blocked by CSP').toEqual([]);
    } finally {
      await context.close();
    }
  });
});
