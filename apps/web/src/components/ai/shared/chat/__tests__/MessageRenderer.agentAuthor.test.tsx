import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { MessageRenderer } from '../MessageRenderer';
import { CompactMessageRenderer } from '../CompactMessageRenderer';
import type { ConversationMessage } from '../message-types';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Test User', accountType: 'human' } }),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => null,
}));

function userMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg-1',
    role: 'user',
    parts: [{ type: 'text', text: 'Hello there' }],
    ...overrides,
  } as unknown as ConversationMessage & UIMessage;
}

const renderers = [
  ['MessageRenderer', MessageRenderer],
  ['CompactMessageRenderer', CompactMessageRenderer],
] as const;

describe.each(renderers)('%s — agent author marker (Agent Signup Phase 2c)', (_name, Renderer) => {
  it('given a message authored by an agent account, renders the AgentBadge beside the author', () => {
    render(<Renderer message={userMessage({ userName: 'PageSpace Support', userAccountType: 'agent' })} />);

    expect(screen.getByText('PageSpace Support')).toBeInTheDocument();
    expect(screen.getByLabelText('AI agent account')).toBeInTheDocument();
  });

  it('given a message authored by a human, renders the name unchanged and no badge', () => {
    render(<Renderer message={userMessage({ userName: 'Ada Lovelace', userAccountType: 'human' })} />);

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });

  it('given an agent-looking name on a human account, does not badge it (the marker never comes from the name)', () => {
    render(<Renderer message={userMessage({ userName: 'Bot (AI agent)', userAccountType: 'human' })} />);

    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });

  it('given no stored author (a live turn), falls back to the viewer and their account type', () => {
    render(<Renderer message={userMessage()} />);

    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });
});
