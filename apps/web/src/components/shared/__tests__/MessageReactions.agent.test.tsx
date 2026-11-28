/**
 * Agent Signup Phase 2c — the reactions tooltip marks an agent reactor from
 * its accountType, never from the self-chosen name; human rows are unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MessageReactions, type Reaction } from '../MessageReactions';

const reaction = (userId: string, name: string, accountType?: string): Reaction => ({
  id: `rx-${userId}`, emoji: '👍', userId, user: { id: userId, name, accountType },
});

const openTooltip = () => {
  vi.useFakeTimers();
  fireEvent.mouseEnter(screen.getByRole('button'));
  act(() => { vi.advanceTimersByTime(400); });
};

afterEach(() => { vi.useRealTimers(); });

describe('MessageReactions — agent marker in the reactor tooltip', () => {
  it('given an agent reactor, should mark it beside its name', () => {
    render(
      <MessageReactions
        reactions={[reaction('u-agent', 'PageSpace Support', 'agent')]}
        currentUserId="u-me" onAddReaction={() => {}} onRemoveReaction={() => {}}
      />
    );
    openTooltip();
    expect(screen.getByText('PageSpace Support')).toBeInTheDocument();
    expect(screen.getByLabelText('AI agent account')).toBeInTheDocument();
  });

  it('given human reactors (with or without an account type), should render the names unchanged and unmarked', () => {
    render(
      <MessageReactions
        reactions={[reaction('u-ada', 'Ada', 'human'), reaction('u-bob', 'Bob')]}
        currentUserId="u-me" onAddReaction={() => {}} onRemoveReaction={() => {}}
      />
    );
    openTooltip();
    expect(screen.getByText('Ada').textContent).toBe('Ada');
    expect(screen.getByText('Bob').textContent).toBe('Bob');
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });

  it('given the viewer is an agent, should show "You" without a marker', () => {
    render(
      <MessageReactions
        reactions={[reaction('u-me', 'Me', 'agent')]}
        currentUserId="u-me" onAddReaction={() => {}} onRemoveReaction={() => {}}
      />
    );
    openTooltip();
    expect(screen.getByText('You').textContent).toBe('You');
    expect(screen.queryByLabelText('AI agent account')).not.toBeInTheDocument();
  });
});
