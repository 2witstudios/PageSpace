/**
 * F1 (PR #2098 review): promote a conversation's optimistic sends into confirmed
 * `messages` when this tab's OWN stream commits. The sender's own tab never
 * receives its own chat:user_message broadcast back, and applyConfirmedMessage
 * reconciles only the assistant id — so without promotion the user's question
 * stayed in optimisticSends and rendered BELOW the reply (the selector orders
 * confirmed before optimistic), compounding every turn. An own reply's commit
 * proves the user rows that triggered it are persisted (the route persists the
 * user message before generating), so promoting them is sound exactly then.
 */
import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { promoteOptimisticSends } from '../promoteOptimisticSends';
import type { ConversationMessagesById } from '../seedEmpty';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

const entry = (messages: UIMessage[], optimisticSends: UIMessage[]): ConversationMessagesById => ({
  c1: { messages, optimisticSends, loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded' },
});

describe('promoteOptimisticSends', () => {
  it('given pending optimistic sends, should append them to messages in send order and clear optimisticSends', () => {
    const result = promoteOptimisticSends(entry([msg('h1')], [msg('u1'), msg('u2')]), 'c1');
    expect(result.c1.messages.map((m) => m.id)).toEqual(['h1', 'u1', 'u2']);
    expect(result.c1.optimisticSends).toEqual([]);
  });

  it('given a promoted send, a subsequent assistant commit should render AFTER it (the ordering fix)', () => {
    const promoted = promoteOptimisticSends(entry([], [msg('u1')]), 'c1');
    // applyConfirmedMessage appends the reply after the promoted user row.
    expect(promoted.c1.messages.map((m) => m.id)).toEqual(['u1']);
  });

  it('should record each promoted send as a remoteMessage pending mutation so an in-flight load replays it', () => {
    const result = promoteOptimisticSends(entry([], [msg('u1')]), 'c1');
    expect(result.c1.pendingMutationsSinceLoad).toEqual([{ type: 'remoteMessage', message: msg('u1') }]);
  });

  it('given no optimistic sends, should return the same reference (no-op, no subscriber churn)', () => {
    const initial = entry([msg('h1')], []);
    expect(promoteOptimisticSends(initial, 'c1')).toBe(initial);
  });

  it('given an untracked conversation, should no-op', () => {
    const initial: ConversationMessagesById = {};
    expect(promoteOptimisticSends(initial, 'c1')).toBe(initial);
  });

  it('should not duplicate a send whose id already reached messages (broadcast/load raced the promotion)', () => {
    const result = promoteOptimisticSends(entry([msg('u1')], [msg('u1'), msg('u2')]), 'c1');
    expect(result.c1.messages.map((m) => m.id)).toEqual(['u1', 'u2']);
  });
});
