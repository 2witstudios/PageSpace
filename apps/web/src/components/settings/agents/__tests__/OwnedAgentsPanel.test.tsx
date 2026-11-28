// @vitest-environment jsdom
/**
 * Settings → Agents (Agent Signup Phase 4): the agents a human owns with name,
 * source and last active, and Revoke / Rotate secret / Unlink per agent, plus
 * a "Claim an agent" code entry that goes to /claim.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';

const fetchMock = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchMock(...args),
}));
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { OwnedAgentsPanel } from '../OwnedAgentsPanel';

const AGENTS = {
  agents: [
    { id: 'agent-1', name: 'Scratch Agent', source: 'claude-code', createdAt: '2026-10-01T00:00:00.000Z', claimedAt: '2026-10-02T00:00:00.000Z', lastActiveAt: '2026-11-20T00:00:00.000Z', revokedAt: null },
    { id: 'agent-2', name: 'Old Agent', source: null, createdAt: '2026-09-01T00:00:00.000Z', claimedAt: '2026-09-02T00:00:00.000Z', lastActiveAt: null, revokedAt: '2026-10-05T00:00:00.000Z' },
  ],
};

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

function wrap(node: ReactNode) {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{node}</SWRConfig>);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/api/account/agents' && (!init || !init.method || init.method === 'GET')) return ok(AGENTS);
    if (url === '/api/account/agents/agent-1/revoke') return ok({ revoked: true });
    if (url === '/api/account/agents/agent-1/unlink') return ok({ unlinked: true, claim_token: 'ps_claim_freshtoken0000000000000' });
    if (url === '/api/agent/secret/rotate') return ok({ identity_assertion: 'ps_agent_newsecret000000000000000000000', agent_id: 'agent-1', secret_version: 2, revoked_existing_tokens: true });
    throw new Error(`unexpected fetch ${url}`);
  });
});

describe('OwnedAgentsPanel', () => {
  it('lists owned agents with name, source and last active, and marks a revoked one', async () => {
    wrap(<OwnedAgentsPanel />);
    const row = await screen.findByTestId('owned-agent-agent-1');
    expect(within(row).getByText('Scratch Agent')).toBeInTheDocument();
    expect(within(row).getByText(/claude-code/)).toBeInTheDocument();
    expect(within(row).getByText(/last active/i)).toBeInTheDocument();
    const revoked = screen.getByTestId('owned-agent-agent-2');
    expect(within(revoked).getByText(/revoked/i)).toBeInTheDocument();
    expect(within(revoked).queryByRole('button', { name: /revoke/i })).not.toBeInTheDocument();
  });

  it('revokes after confirmation', async () => {
    wrap(<OwnedAgentsPanel />);
    const row = await screen.findByTestId('owned-agent-agent-1');
    await userEvent.click(within(row).getByRole('button', { name: /^revoke$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /revoke agent/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/account/agents/agent-1/revoke', expect.objectContaining({ method: 'POST' })));
  });

  it('rotates the secret (optionally revoking live tokens) and shows the new secret once', async () => {
    wrap(<OwnedAgentsPanel />);
    const row = await screen.findByTestId('owned-agent-agent-1');
    await userEvent.click(within(row).getByRole('button', { name: /rotate secret/i }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /also sign it out everywhere/i }));
    await userEvent.click(screen.getByRole('button', { name: /^rotate$/i }));
    await screen.findByText('ps_agent_newsecret000000000000000000000');
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/agent/secret/rotate');
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ agentId: 'agent-1', revokeExistingTokens: true });
  });

  it('unlinks after confirmation and shows the fresh claim token once', async () => {
    wrap(<OwnedAgentsPanel />);
    const row = await screen.findByTestId('owned-agent-agent-1');
    await userEvent.click(within(row).getByRole('button', { name: /unlink/i }));
    await userEvent.click(await screen.findByRole('button', { name: /unlink agent/i }));
    await screen.findByText('ps_claim_freshtoken0000000000000');
    expect(fetchMock).toHaveBeenCalledWith('/api/account/agents/agent-1/unlink', expect.objectContaining({ method: 'POST' }));
  });

  it('sends a typed claim code to /claim', async () => {
    wrap(<OwnedAgentsPanel />);
    await userEvent.type(screen.getByLabelText(/agent code/i), 'abcd-efgh');
    await userEvent.click(screen.getByRole('button', { name: /claim an agent/i }));
    expect(pushMock).toHaveBeenCalledWith('/claim?user_code=ABCD-EFGH');
  });

  it('shows an empty state when the human owns no agents', async () => {
    fetchMock.mockImplementation(() => ok({ agents: [] }));
    wrap(<OwnedAgentsPanel />);
    await screen.findByText(/you have not claimed any agents/i);
  });
});
