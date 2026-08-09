import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import type { RenderedMessage } from '../selectRenderedMessages';
import { planRetry } from '../planRetry';

const msg = (id: string, role: UIMessage['role']): UIMessage => ({ id, role, parts: [] });
const confirmed = (id: string, role: UIMessage['role']): RenderedMessage => ({
  message: msg(id, role),
  mode: 'confirmed',
});
const optimistic = (id: string, role: UIMessage['role']): RenderedMessage => ({
  message: msg(id, role),
  mode: 'optimistic',
});
const streaming = (id: string): RenderedMessage => ({
  message: msg(id, 'assistant'),
  mode: 'streaming',
});

describe('planRetry', () => {
  it('given a completed reply after the last user message, plans to delete it and names the last user message', () => {
    const rendered = [confirmed('u1', 'user'), confirmed('a1', 'assistant')];
    expect(planRetry(rendered)).toEqual({
      assistantIdsToDelete: ['a1'],
      lastUserMessage: msg('u1', 'user'),
    });
  });

  it('given multiple trailing assistant replies, plans to delete all of them', () => {
    const rendered = [confirmed('u1', 'user'), confirmed('a1', 'assistant'), confirmed('a2', 'assistant')];
    expect(planRetry(rendered).assistantIdsToDelete).toEqual(['a1', 'a2']);
  });

  it('given no reply yet after the last user message, plans to delete nothing', () => {
    const rendered = [confirmed('a1', 'assistant'), confirmed('u1', 'user')];
    expect(planRetry(rendered)).toEqual({ assistantIdsToDelete: [], lastUserMessage: msg('u1', 'user') });
  });

  it('given an optimistic send as the last user turn, names it as the last user message', () => {
    const rendered = [confirmed('u1', 'user'), confirmed('a1', 'assistant'), optimistic('u2', 'user')];
    expect(planRetry(rendered).lastUserMessage).toEqual(msg('u2', 'user'));
  });

  it('given a live stream anywhere in the rendered list, plans to delete nothing and names no user message', () => {
    const rendered = [confirmed('u1', 'user'), confirmed('a1', 'assistant'), streaming('a2')];
    expect(planRetry(rendered)).toEqual({ assistantIdsToDelete: [], lastUserMessage: undefined });
  });

  it('given an empty rendered list, plans to delete nothing', () => {
    expect(planRetry([])).toEqual({ assistantIdsToDelete: [], lastUserMessage: undefined });
  });
});
