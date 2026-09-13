/**
 * The OAuth consent screen (server component). Rendered for real against the
 * real `@pagespace/lib` OAuth contracts; only the session, the database and
 * Next's navigation primitives are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('server-only', () => ({}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ toString: () => 'session=ps_sess_test' })),
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  getSessionFromCookies: vi.fn(() => 'ps_sess_test'),
}));

vi.mock('@pagespace/lib/auth/session-service', () => ({
  sessionService: { validateSession: vi.fn(async () => ({ userId: 'user-1' })) },
}));

const findDrivesByIds = vi.fn();
const findActiveMcpTokenByIdAndUser = vi.fn();
vi.mock('@/lib/repositories/session-repository', () => ({
  sessionRepository: {
    findDrivesByIds: (...args: unknown[]) => findDrivesByIds(...args),
    findActiveMcpTokenByIdAndUser: (...args: unknown[]) => findActiveMcpTokenByIdAndUser(...args),
  },
}));

vi.mock('@pagespace/db/db', () => ({
  db: { query: { driveRoles: { findFirst: vi.fn().mockResolvedValue(undefined) } } },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/members', () => ({ driveRoles: {} }));

vi.mock('@/lib/auth/auth-fetch', () => ({ post: vi.fn() }));

import ConsentPage from '../page';

const REDIRECT_URI = 'http://127.0.0.1:51234/callback';

function consentParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    client_id: 'pagespace-cli',
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    scope: 'account',
    state: 'xyz123',
    ...overrides,
  };
}

async function renderConsent(overrides: Record<string, string> = {}) {
  const element = await ConsentPage({ searchParams: Promise.resolve(consentParams(overrides)) });
  return render(element);
}

function capabilityItems(): string[] {
  return screen.getAllByRole('listitem').map((li) => li.textContent ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  findDrivesByIds.mockResolvedValue([]);
  findActiveMcpTokenByIdAndUser.mockResolvedValue({ id: 'tok1', name: 'my-key' });
});

describe('consent page — narration via describeGrantScopes', () => {
  for (const scope of ['profile', 'profile offline_access']) {
    it(`renders a non-empty capability list naming the identity fields for "${scope}"`, async () => {
      await renderConsent({ scope });

      const items = capabilityItems();
      expect(items.length).toBeGreaterThan(0);
      expect(items[0]).toBe('See your name, email, and avatar. No access to any drive or content.');
    });
  }

  it('never shows "No access to any drive or content" on a profile drive:X:member consent', async () => {
    findDrivesByIds.mockResolvedValue([{ id: 'abc123', name: 'Acme Drive' }]);

    await renderConsent({ scope: 'profile drive:abc123:member' });

    const items = capabilityItems();
    expect(items).toContain('See your name, email, and avatar.');
    expect(items.join('\n')).not.toContain('No access to any drive or content');
    expect(items.join('\n')).toContain('Acme Drive');
  });

  it('still names the key an update_key consent re-scopes', async () => {
    await renderConsent({ scope: 'update_key:tok1 drive:abc123:member' });

    expect(capabilityItems()[0]).toContain('"my-key"');
  });

  it('still names the key a mint grant will create first', async () => {
    await renderConsent({ scope: 'drive:abc123:member name:ci-key' });

    expect(capabilityItems()[0]).toContain('"ci-key"');
  });
});
