/**
 * Settings identity card for an AI agent's session (Agent Signup Phase 3):
 * id, account type, owner or Unclaimed, Rotate secret (reveal-once dialog via
 * the existing rotate route), and a claim link for an unclaimed agent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/auth-fetch')>()),
  post: mocks.post,
}));

import { useAuthStore } from '@/stores/useAuthStore';
import { useEditingStore } from '@/stores/useEditingStore';
import { AgentIdentityCard } from '../AgentIdentityCard';

type StoreUser = NonNullable<ReturnType<typeof useAuthStore.getState>['user']>;
const setUser = (user: Partial<StoreUser>) =>
  useAuthStore.setState({ user: { id: 'agent-1', name: 'Bot', email: 'agent-agent-1@agents.pagespace.invalid', ...user } as StoreUser });

const NEW_SECRET = 'ps_agent_zyxwvutsrqponmlkjihgfedcba543210';
const originalLocation = window.location;

describe('AgentIdentityCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: { href: 'http://localhost/settings/account' } });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    useEditingStore.getState().clearAllSessions();
  });

  it('given a human, should render nothing', () => {
    setUser({ id: 'human-1', accountType: 'human' });
    const { container } = render(<AgentIdentityCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('given an unclaimed agent, should show id, account type, Unclaimed and a claim link button', () => {
    setUser({ accountType: 'agent', agent: { ownerUserId: null, claimedAt: null, source: 'claude-code' } });
    render(<AgentIdentityCard />);
    expect(screen.getByTestId('agent-identity-id')).toHaveTextContent('agent-1');
    expect(screen.getByText('AI agent')).toBeInTheDocument();
    expect(screen.getByTestId('agent-identity-owner')).toHaveTextContent('Unclaimed');
    expect(screen.getByText('claude-code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get claim link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy agent ID' })).toBeInTheDocument();
  });

  it('given a claimed agent, should name the owner and offer no claim link', () => {
    setUser({ accountType: 'agent', agent: { ownerUserId: 'human-9', claimedAt: '2026-11-01T00:00:00Z', source: null } });
    render(<AgentIdentityCard />);
    expect(screen.getByTestId('agent-identity-owner')).toHaveTextContent('Claimed by human-9');
    expect(screen.queryByRole('button', { name: 'Get claim link' })).not.toBeInTheDocument();
  });

  it('should rotate through the existing route and reveal the new secret once, Done gated on saving it', async () => {
    setUser({ accountType: 'agent', agent: { ownerUserId: null, claimedAt: null, source: null } });
    mocks.post.mockResolvedValue({ identity_assertion: NEW_SECRET, agent_id: 'agent-1', secret_version: 2, revoked_existing_tokens: false });
    render(<AgentIdentityCard />);

    fireEvent.click(screen.getByRole('button', { name: 'Rotate secret' }));
    expect(useEditingStore.getState().isAnyActive()).toBe(true);
    // The dialog's own confirm button is the last "Rotate secret" in the document.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Rotate secret' })).at(-1) as HTMLElement);

    expect(await screen.findByTestId('rotated-agent-secret')).toHaveTextContent(NEW_SECRET);
    expect(mocks.post).toHaveBeenCalledWith('/api/agent/secret/rotate', { revokeExistingTokens: false });
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have saved my new secret' }));
    fireEvent.click(done);
    expect(screen.queryByTestId('rotated-agent-secret')).not.toBeInTheDocument();
    expect(window.location.href).toBe('http://localhost/settings/account');
  });

  it('given "sign out everywhere", should send revokeExistingTokens and go to agent sign-in after Done', async () => {
    setUser({ accountType: 'agent', agent: { ownerUserId: null, claimedAt: null, source: null } });
    mocks.post.mockResolvedValue({ identity_assertion: NEW_SECRET, agent_id: 'agent-1', secret_version: 2, revoked_existing_tokens: true });
    render(<AgentIdentityCard />);

    fireEvent.click(screen.getByRole('button', { name: 'Rotate secret' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Also sign out everywhere/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Rotate secret' }).at(-1) as HTMLElement);

    await screen.findByTestId('rotated-agent-secret');
    expect(mocks.post).toHaveBeenCalledWith('/api/agent/secret/rotate', { revokeExistingTokens: true });
    fireEvent.click(screen.getByRole('checkbox', { name: 'I have saved my new secret' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(window.location.href).toBe('/auth/agent?mode=signin');
  });

  it('given the rotation fails, should keep the confirm step with an error', async () => {
    setUser({ accountType: 'agent', agent: { ownerUserId: null, claimedAt: null, source: null } });
    mocks.post.mockRejectedValue(new Error('429'));
    render(<AgentIdentityCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate secret' }));
    fireEvent.click((await screen.findAllByRole('button', { name: 'Rotate secret' })).at(-1) as HTMLElement);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not rotate the secret. Try again later.');
  });
});
