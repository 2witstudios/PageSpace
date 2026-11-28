import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { CompactMessageRenderer } from '../CompactMessageRenderer';
import type { ConversationMessage } from '../message-types';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Test User' } }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => null,
}));

const message = {
  id: 'msg-1',
  role: 'assistant',
  parts: [
    { type: 'data-spend-fallback', id: 'msg-1-spend-fallback', data: { from: 'drive_wallet', to: 'own_credits', walletId: 'w-marcus' } },
    { type: 'text', text: 'The answer' },
  ],
} as unknown as ConversationMessage & UIMessage;

describe('CompactMessageRenderer — a reply that fell back to another source', () => {
  it('SPEND-4 (partial) shows the source it moved to and from, above the reply', () => {
    render(<CompactMessageRenderer message={message} />);

    expect(screen.getByRole('status').textContent).toBe("Used your own credits because the drive wallet couldn't cover this.");
    expect(screen.getByText('The answer')).toBeInTheDocument();
  });
});
