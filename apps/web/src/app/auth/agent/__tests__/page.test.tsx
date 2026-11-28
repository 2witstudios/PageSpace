/**
 * /auth/agent server page (Agent Signup Phase 3): 404 when the door is closed,
 * the `pagespace-agent-auth` meta pointing at /auth.md, visually-hidden
 * instructions for computer-use agents, and only a SAFE `next` passed on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ open: vi.fn(), client: vi.fn() }));

vi.mock('@/lib/agent-auth/door', () => ({ isAgentDoorOpen: () => mocks.open() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('../AgentAuthClient', () => ({
  AgentAuthClient: (props: { nextPath?: string }) => {
    mocks.client(props);
    return <div data-testid="agent-auth-client" />;
  },
}));

import AgentAuthPage, { metadata } from '../page';

const page = (params: { mode?: string; next?: string } = {}) => AgentAuthPage({ searchParams: Promise.resolve(params) });

describe('/auth/agent page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.open.mockReturnValue(true);
  });

  it('should declare <meta name="pagespace-agent-auth" content="/auth.md">', () => {
    expect(metadata.other).toEqual({ 'pagespace-agent-auth': '/auth.md' });
  });

  it('given the door is closed, should 404', async () => {
    mocks.open.mockReturnValue(false);
    await expect(page({ mode: 'signup' })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('should render visually-hidden instructions that point computer-use agents at /auth.md', async () => {
    render(await page({ mode: 'signup' }));
    const instructions = screen.getByTestId('agent-instructions');
    expect(instructions).toHaveClass('sr-only');
    expect(instructions).toHaveTextContent('/auth.md');
    expect(instructions).toHaveTextContent('I have saved my secret');
    expect(instructions).toHaveTextContent('/auth/agent?mode=signin');
    expect(screen.getByTestId('agent-auth-client')).toBeInTheDocument();
  });

  it('given a safe next, should pass it to the client', async () => {
    render(await page({ mode: 'signin', next: '/dashboard/drive-1' }));
    expect(mocks.client).toHaveBeenCalledWith({ nextPath: '/dashboard/drive-1' });
  });

  it.each(['https://evil.example', '//evil.example/x', '/settings'])('given an unsafe next %s, should drop it', async (next) => {
    render(await page({ mode: 'signin', next }));
    expect(mocks.client).toHaveBeenCalledWith({});
  });
});
