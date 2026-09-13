/**
 * The OAuth consent screen (server component). Rendered for real against the
 * real `@pagespace/lib` OAuth contracts; only the session, the database and
 * Next's navigation primitives are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('server-only', () => ({}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ toString: (): string => 'session=ps_sess_test' })),
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

const resolveClient = vi.fn();
vi.mock('@/lib/repositories/oauth-repository', () => ({
  resolveClient: (...args: unknown[]) => resolveClient(...args),
}));

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

beforeEach(async () => {
  vi.clearAllMocks();
  const { getRegisteredClient } = await vi.importActual<typeof import('@pagespace/lib/auth/oauth/clients')>(
    '@pagespace/lib/auth/oauth/clients',
  );
  resolveClient.mockImplementation(async (clientId: string) => getRegisteredClient(clientId));
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

const THIRD_PARTY_REDIRECT = 'https://swipesend.app/auth/pagespace/callback';
const THIRD_PARTY = {
  clientId: 'app_swipesend',
  name: 'SwipeSend',
  type: 'public' as const,
  redirectUris: [THIRD_PARTY_REDIRECT],
  allowedGrantTypes: ['authorization_code', 'refresh_token'],
  allowedScopes: ['profile', 'offline_access'],
  firstParty: false,
  verified: false,
};

describe('consent page — third-party client resolved through resolveClient', () => {
  beforeEach(() => {
    resolveClient.mockImplementation(async (clientId: string) => (clientId === THIRD_PARTY.clientId ? THIRD_PARTY : null));
  });

  it('renders consent for a request inside the client\'s cap', async () => {
    await renderConsent({ client_id: 'app_swipesend', redirect_uri: THIRD_PARTY_REDIRECT, scope: 'profile offline_access' });

    expect(resolveClient).toHaveBeenCalledWith('app_swipesend');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('SwipeSend');
  });

  it('redirects with error=invalid_scope for a scope beyond the cap BEFORE rendering anything', async () => {
    const rendering = ConsentPage({
      searchParams: Promise.resolve(
        consentParams({ client_id: 'app_swipesend', redirect_uri: THIRD_PARTY_REDIRECT, scope: 'profile drive:abc123:member' }),
      ),
    });

    const signal = await rendering.then(
      () => null,
      (error: unknown) => error,
    );
    expect(signal).toBeInstanceOf(RedirectSignal);
    const location = new URL((signal as RedirectSignal).url);
    expect(location.origin + location.pathname).toBe(THIRD_PARTY_REDIRECT);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(findDrivesByIds).not.toHaveBeenCalled();
  });

  it('renders the same error for an unknown client, a disabled client and a foreign redirect_uri (G17)', async () => {
    const MESSAGE = 'Unknown client or unregistered redirect_uri.';
    const first = await renderConsent({ client_id: 'app_nope', redirect_uri: THIRD_PARTY_REDIRECT, scope: 'profile' });
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    first.unmount();

    resolveClient.mockResolvedValueOnce(null);
    const second = await renderConsent({ client_id: 'app_swipesend', redirect_uri: THIRD_PARTY_REDIRECT, scope: 'profile' });
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
    second.unmount();

    await renderConsent({ client_id: 'app_swipesend', redirect_uri: 'https://evil.example/cb', scope: 'profile' });
    expect(screen.getByText(MESSAGE)).toBeInTheDocument();
  });
});

describe('consent page — who is asking (ADR 0004 Decision 8)', () => {
  it('shows an unverified app\'s name and homepage, labels it "Unverified app", and loads NO logo from the app\'s host', async () => {
    resolveClient.mockImplementation(async () => ({
      ...THIRD_PARTY,
      verified: false,
      logoUrl: 'https://swipesend.app/logo.png',
      homepageUrl: 'https://swipesend.app/about',
    }));

    const { container } = await renderConsent({ client_id: 'app_swipesend', redirect_uri: THIRD_PARTY_REDIRECT, scope: 'profile' });

    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('SwipeSend');
    // No <img>, and nothing anywhere in the markup that would make the
    // browser contact the app's host before the user decides.
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.innerHTML).not.toContain('swipesend.app/logo.png');
    expect(screen.getByTestId('consent-client-initial').textContent).toBe('S');
    const homepage = screen.getByRole('link', { name: 'swipesend.app' });
    expect(homepage.getAttribute('href')).toBe('https://swipesend.app/about');
    expect(homepage.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText('Unverified app')).toBeInTheDocument();
    expect(screen.queryByText('Built by PageSpace')).not.toBeInTheDocument();
  });

  it('loads a VERIFIED app\'s logo, with no referrer', async () => {
    resolveClient.mockImplementation(async () => ({ ...THIRD_PARTY, verified: true, logoUrl: 'https://swipesend.app/logo.png' }));

    await renderConsent({ client_id: 'app_swipesend', redirect_uri: THIRD_PARTY_REDIRECT, scope: 'profile' });

    const logo = screen.getByRole('img', { name: 'SwipeSend logo' });
    expect(logo.getAttribute('src')).toBe('https://swipesend.app/logo.png');
    expect(logo.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(screen.queryByTestId('consent-client-initial')).not.toBeInTheDocument();
  });

  it('drops "Unverified app" for a verified third-party app', async () => {
    resolveClient.mockImplementation(async () => ({ ...THIRD_PARTY, verified: true }));

    await renderConsent({ client_id: 'app_swipesend', redirect_uri: THIRD_PARTY_REDIRECT, scope: 'profile' });

    expect(screen.queryByText('Unverified app')).not.toBeInTheDocument();
    expect(screen.queryByText('Built by PageSpace')).not.toBeInTheDocument();
  });

  it('labels the first-party CLI "Built by PageSpace" and not unverified', async () => {
    await renderConsent({ scope: 'account' });

    expect(screen.getByText('Built by PageSpace')).toBeInTheDocument();
    expect(screen.queryByText('Unverified app')).not.toBeInTheDocument();
  });

  it('renders profile narration first on a mixed identity + drive consent', async () => {
    resolveClient.mockImplementation(async () => ({ ...THIRD_PARTY, allowedScopes: ['profile', 'drive:member', 'offline_access'] }));
    findDrivesByIds.mockResolvedValue([{ id: 'abc123', name: 'Acme Drive' }]);

    await renderConsent({
      client_id: 'app_swipesend',
      redirect_uri: THIRD_PARTY_REDIRECT,
      scope: 'offline_access drive:abc123:member profile',
    });

    expect(capabilityItems()[0]).toBe('See your name, email, and avatar.');
  });
});

