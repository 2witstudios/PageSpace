/**
 * The /auth/agent client (Agent Signup Phase 3, US2): signup solves the PoW
 * (in a worker — mocked here) with progress text, posts to the browser door,
 * and shows the once-only reveal card whose Continue waits for "I have saved
 * my secret"; signin posts the secret and navigates. Both gate on csrfToken.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  params: { current: new URLSearchParams('mode=signup') },
  csrf: { current: 'login-csrf' as string | null },
  refresh: vi.fn(),
  solve: vi.fn(),
  claimPost: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => mocks.params.current,
}));
vi.mock('@/hooks/useAuthCSRF', () => ({ useAuthCSRF: () => ({ csrfToken: mocks.csrf.current, refreshToken: mocks.refresh }) }));
vi.mock('@/lib/agent-auth/pow/solve-in-browser', () => ({ solvePowInBrowser: mocks.solve }));
vi.mock('@/lib/analytics', () => ({ getOrCreateDeviceId: () => 'dev-1', getDeviceName: () => 'Chrome' }));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/auth-fetch')>()),
  post: mocks.claimPost,
}));

import { AgentAuthClient, describeAgentAuthError } from '../AgentAuthClient';
import { useEditingStore } from '@/stores/useEditingStore';

const SECRET = 'ps_agent_abcdefghijklmnopqrstuvwxyz012345';
const CLAIM = 'ps_claim_abcdefghijklmnopqrstuvwxyz012345';

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.params.current = new URLSearchParams('mode=signup');
  mocks.csrf.current = 'login-csrf';
  mocks.refresh.mockResolvedValue('fresh-csrf');
  mocks.solve.mockImplementation(async ({ onProgress }: { onProgress: (a: number, e: number) => void }) => {
    onProgress(20_000, 1_048_576);
    return '4242';
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', { configurable: true, value: { href: 'http://localhost/auth/agent' } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  useEditingStore.getState().clearAllSessions();
});

const fillSignup = () => {
  fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Browser Agent' } });
  fireEvent.change(screen.getByLabelText('Which agent are you? (optional)'), { target: { value: 'computer-use' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /I accept the/ }));
};

describe('AgentAuthClient — signup', () => {
  it('given no csrfToken yet, should keep Create disabled', () => {
    mocks.csrf.current = null;
    render(<AgentAuthClient />);
    fillSignup();
    expect(screen.getByRole('button', { name: 'Create agent account' })).toBeDisabled();
  });

  it('should require a name and the terms before Create enables', () => {
    render(<AgentAuthClient />);
    const create = screen.getByRole('button', { name: 'Create agent account' });
    expect(create).toBeDisabled();
    fillSignup();
    expect(create).toBeEnabled();
  });

  it('should solve the fetched challenge, post the browser signup and reveal the secret once', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { challenge: 'ps_pow_c', difficulty_bits: 20 }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, agentId: 'agent-1', secret: SECRET, claimToken: CLAIM, redirectUrl: '/dashboard/d1', csrfToken: 'x', deviceToken: 'ps_dev_x' }));
    render(<AgentAuthClient nextPath="/dashboard/d1" />);
    fillSignup();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent account' }));

    expect(await screen.findByTestId('agent-secret')).toHaveTextContent(SECRET);
    expect(mocks.solve).toHaveBeenCalledWith(expect.objectContaining({ challenge: 'ps_pow_c', difficultyBits: 20 }));
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/agent/challenge', { cache: 'no-store' });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe('/api/auth/agent/signup');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Browser Agent', source: 'computer-use', tosAccepted: true, pow: { challenge: 'ps_pow_c', nonce: '4242' },
      csrfToken: 'fresh-csrf', platform: 'web', deviceId: 'dev-1', deviceName: 'Chrome', next: '/dashboard/d1',
    });
    expect(screen.getByTestId('agent-id')).toHaveTextContent('agent-1');
    expect(screen.getByTestId('agent-claim-token')).toHaveTextContent(CLAIM);
    expect(screen.getByRole('button', { name: 'Copy secret' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get claim link' })).toBeInTheDocument();
    expect(localStorage.getItem('deviceToken')).toBe('ps_dev_x');
  });

  it('should show progress text while the proof of work runs', async () => {
    let release: (nonce: string) => void = () => {};
    mocks.solve.mockImplementation(({ onProgress }: { onProgress: (a: number, e: number) => void }) => {
      onProgress(40_000, 1_048_576);
      return new Promise<string>((resolve) => { release = resolve; });
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { challenge: 'ps_pow_c', difficulty_bits: 20 }));
    render(<AgentAuthClient />);
    fillSignup();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent account' }));
    expect(await screen.findByText('Proving work… 40,000 hashes tried (about 1,048,576 expected)')).toBeInTheDocument();
    release('1');
  });

  it('should keep Continue disabled until "I have saved my secret", then go to the redirect', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { challenge: 'ps_pow_c', difficulty_bits: 20 }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, agentId: 'agent-1', secret: SECRET, claimToken: CLAIM, redirectUrl: '/dashboard', csrfToken: 'x' }));
    render(<AgentAuthClient />);
    fillSignup();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent account' }));
    const continueButton = await screen.findByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have saved my secret' }));
    expect(continueButton).toBeEnabled();
    fireEvent.click(continueButton);
    expect(window.location.href).toBe('/dashboard');
  });

  it('should register the reveal with the editing store so no refresh can unmount it', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { challenge: 'ps_pow_c', difficulty_bits: 20 }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, agentId: 'agent-1', secret: SECRET, claimToken: CLAIM, redirectUrl: '/dashboard', csrfToken: 'x' }));
    render(<AgentAuthClient />);
    fillSignup();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent account' }));
    await screen.findByTestId('agent-secret-reveal');
    expect(useEditingStore.getState().isAnyActive()).toBe(true);
  });

  it('given the session could not start, should still reveal the secret and point at sign-in instead of a claim link', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { challenge: 'ps_pow_c', difficulty_bits: 20 }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, agentId: 'agent-1', secret: SECRET, claimToken: CLAIM, sessionStarted: false, redirectUrl: '/auth/agent?mode=signin' }));
    render(<AgentAuthClient />);
    fillSignup();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent account' }));
    expect(await screen.findByTestId('agent-secret')).toHaveTextContent(SECRET);
    expect(screen.queryByRole('button', { name: 'Get claim link' })).not.toBeInTheDocument();
  });

  it('given a refused signup, should show the error and stay on the form', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { challenge: 'ps_pow_c', difficulty_bits: 20 }))
      .mockResolvedValueOnce(jsonResponse(403, { error: 'pow_invalid' }));
    render(<AgentAuthClient />);
    fillSignup();
    fireEvent.click(screen.getByRole('button', { name: 'Create agent account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The proof of work was not accepted. Try again.');
    expect(screen.queryByTestId('agent-secret-reveal')).not.toBeInTheDocument();
  });
});

describe('AgentAuthClient — signin', () => {
  beforeEach(() => {
    mocks.params.current = new URLSearchParams('mode=signin');
  });

  it('should render the secret form and a link back to signup', () => {
    render(<AgentAuthClient />);
    expect(screen.getByRole('heading', { name: 'Sign in as an AI agent' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an agent account' })).toHaveAttribute('href', '/auth/agent?mode=signup');
  });

  it('given no csrfToken, should keep Sign in disabled', () => {
    mocks.csrf.current = null;
    render(<AgentAuthClient />);
    fireEvent.change(screen.getByLabelText('Agent secret'), { target: { value: SECRET } });
    expect(screen.getByRole('button', { name: 'Sign in as agent' })).toBeDisabled();
  });

  it('should post the secret with a fresh CSRF and navigate to the redirect', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, agentId: 'agent-1', redirectUrl: '/dashboard/d1', csrfToken: 'x' }));
    render(<AgentAuthClient nextPath="/dashboard/d1" />);
    fireEvent.change(screen.getByLabelText('Agent secret'), { target: { value: `  ${SECRET} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as agent' }));
    await waitFor(() => expect(window.location.href).toBe('/dashboard/d1'));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/agent/signin');
    expect(JSON.parse(init.body as string)).toEqual({ secret: SECRET, csrfToken: 'fresh-csrf', platform: 'web', deviceId: 'dev-1', deviceName: 'Chrome', next: '/dashboard/d1' });
  });

  it('given the constant 401, should say the secret was not accepted', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'invalid_credentials' }));
    render(<AgentAuthClient />);
    fireEvent.change(screen.getByLabelText('Agent secret'), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as agent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That agent secret was not accepted.');
  });
});

describe('describeAgentAuthError', () => {
  it.each([
    [429, { error: 'rate_limited', retryAfter: 600 }, 'signup', 'Too many attempts from this network. Try again in 10 minutes.'],
    [403, { error: 'invalid_csrf' }, 'signin', 'This form expired. Try again.'],
    [404, { error: 'not_found' }, 'signup', 'Agent accounts are not available on this PageSpace.'],
    [400, { error: 'invalid_request' }, 'signup', 'Could not create the agent account. Try again.'],
    [503, { error: 'temporarily_unavailable' }, 'signin', 'Could not sign in. Try again.'],
  ] as const)('given %s %o (%s), should say %s', (status, body, mode, expected) => {
    expect(describeAgentAuthError(status, body, mode)).toBe(expected);
  });
});
