import { describe, expect, it } from 'vitest';
import { PageSpaceClient } from '../../client.js';
import { StaticTokenProvider } from '../../auth/static.js';
import { getAuthMe } from '../auth.js';

const FULL_BODY = {
  id: 'user_1',
  name: 'Maya',
  email: 'maya@example.com',
  image: null,
  role: 'user',
  emailVerified: '2026-09-01T00:00:00.000Z',
  subscriptionTier: 'pro',
};

/** What `/api/auth/me` returns to a third-party app holding `profile` — "and not one field more". */
const PROFILE_BODY = { id: 'user_1', name: 'Maya', email: 'maya@example.com', image: '/avatars/u1.png' };

describe('getAuthMe (auth.me)', () => {
  it('is GET /api/auth/me, identity-scoped, with no input fields', () => {
    expect(getAuthMe.name).toBe('auth.me');
    expect(getAuthMe.method).toBe('GET');
    expect(getAuthMe.path).toBe('/api/auth/me');
    expect(getAuthMe.requiredScope).toBe('profile');
    expect(getAuthMe.inputSchema.safeParse({}).success).toBe(true);
    expect(getAuthMe.inputSchema.safeParse({ userId: 'someone-else' }).success).toBe(false);
  });

  it('reads the full body a session or first-party client gets', () => {
    const parsed = getAuthMe.outputSchema.safeParse(FULL_BODY);
    expect(parsed.success && parsed.data).toEqual(FULL_BODY);
  });

  it('reads the profile-only body a third-party app gets, adding no fields', () => {
    const parsed = getAuthMe.outputSchema.safeParse(PROFILE_BODY);
    expect(parsed.success && parsed.data).toEqual(PROFILE_BODY);
  });

  it('fails closed on a body missing the identity core', () => {
    expect(getAuthMe.outputSchema.safeParse({ name: 'Maya', email: 'maya@example.com' }).success).toBe(false);
    expect(getAuthMe.outputSchema.safeParse({ ...PROFILE_BODY, email: null }).success).toBe(false);
  });

  it('is reachable as client.auth.me() and carries the bearer', async () => {
    let seen: { url: string; authorization: string | undefined } | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(input), authorization: (init?.headers as Record<string, string> | undefined)?.Authorization };
      return new Response(JSON.stringify(PROFILE_BODY), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const client = new PageSpaceClient({
      baseUrl: 'https://pagespace.ai',
      auth: new StaticTokenProvider('ps_at_x'),
      fetch: fetchImpl,
      skipVersionCheck: true,
    });

    await expect(client.auth.me({})).resolves.toEqual(PROFILE_BODY);
    expect(seen).toEqual({ url: 'https://pagespace.ai/api/auth/me', authorization: 'Bearer ps_at_x' });
  });
});
