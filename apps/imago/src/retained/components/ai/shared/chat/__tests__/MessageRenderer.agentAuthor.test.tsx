// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { MessageRenderer } from '../MessageRenderer';
import { CompactMessageRenderer } from '../CompactMessageRenderer';
import type { ConversationMessage } from '../message-types';

vi.mock('@/retained/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'user-1', name: 'Test User' } }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn(), forward: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

vi.mock('@/retained/hooks/useSocket', () => ({
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

afterEach(cleanup);

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

  it('given no stored author (a live turn), shows the viewer and no badge', () => {
    render(<Renderer message={userMessage({ userAccountType: 'agent' })} />);

    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });
});
