/**
 * L2·G2 review (Codex P2) — the Accounts panel renders INSIDE the agent
 * settings `<form>`. Its buttons must never submit that form: clicking Add
 * account or Revoke would otherwise persist unrelated dirty agent settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/hooks/useAgentAccounts', () => ({
  agentAccountsUrl: () => '/api/agents/p/accounts',
  useAgentAccounts: () => ({
    configured: true,
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
    accounts: [{ id: 'acct_1', kind: 'api_key', name: 'Weather', ownerKind: 'agent_page', providerSlug: null, allowedOrigins: ['https://api.weather.example:443'], acknowledgment: 'dedicated_agent_account', status: 'active', upstreamRevocation: null, lastUsedAt: null, createdAt: 1, revokedAt: null, ready: true }],
  }),
}));
vi.mock('@/lib/auth/auth-fetch', () => ({ post: vi.fn(async () => ({})) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AgentAccountsPanel } from '../AgentAccountsPanel';

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);
});

describe('AgentAccountsPanel inside a form', () => {
  it('given Add account and Revoke clicked, should never submit the surrounding settings form', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <AgentAccountsPanel scope={{ kind: 'agent_page', pageId: 'p' }} />
      </form>,
    );
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    fireEvent.click(screen.getByRole('button', { name: /add account/i }));
    const actual = onSubmit.mock.calls.length;
    const expected = 0;
    expect(actual).toEqual(expected);
  });

  it('given an account, should show its name, site and the acknowledgment it was added with — never a key', () => {
    render(<AgentAccountsPanel scope={{ kind: 'agent_page', pageId: 'p' }} />);
    const actual = [screen.queryByText('Weather') !== null, screen.queryByText(/api\.weather\.example/) !== null, screen.queryByText('Dedicated account') !== null];
    const expected = [true, true, true];
    expect(actual).toEqual(expected);
  });
});
