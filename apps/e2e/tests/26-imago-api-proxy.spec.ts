import { test, expect, type APIRequestContext } from '@playwright/test';
import { seedUser, type SeededUser } from '../support/db';

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
