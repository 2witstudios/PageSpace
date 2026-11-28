import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/auth-fetch')>()),
  post: mocks.post,
}));

import { ApiRequestError } from '@/lib/auth/auth-fetch';
import { AgentClaimLink } from '../AgentClaimLink';

const LINK = {
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://pagespace.test/claim',
  verification_uri_complete: 'https://pagespace.test/claim?user_code=ABCD-EFGH',
  expires_in: 900,
  interval: 5,
};

describe('AgentClaimLink', () => {
  beforeEach(() => vi.clearAllMocks());

  it('given a click, should request a session claim and show the link with its code and lifetime', async () => {
    mocks.post.mockResolvedValue(LINK);
    render(<AgentClaimLink />);
    fireEvent.click(screen.getByRole('button', { name: 'Get claim link' }));
    expect(await screen.findByTestId('agent-claim-url')).toHaveTextContent(LINK.verification_uri_complete);
    expect(mocks.post).toHaveBeenCalledWith('/api/agent/claim/session');
    expect(screen.getByText(/15 minutes/)).toBeInTheDocument();
    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy claim link' })).toBeInTheDocument();
  });

  it('given the agent is already claimed, should say so', async () => {
    mocks.post.mockRejectedValue(new ApiRequestError('already_claimed', 409));
    render(<AgentClaimLink />);
    fireEvent.click(screen.getByRole('button', { name: 'Get claim link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This agent already has an owner.');
  });

  it('given any other failure, should offer a retry', async () => {
    mocks.post.mockRejectedValue(new Error('network'));
    render(<AgentClaimLink />);
    fireEvent.click(screen.getByRole('button', { name: 'Get claim link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create a claim link. Try again.');
    expect(screen.getByRole('button', { name: 'Get claim link' })).toBeEnabled();
  });
});
