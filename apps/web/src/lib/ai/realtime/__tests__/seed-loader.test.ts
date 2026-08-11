import { describe, expect, it, vi } from 'vitest';
import {
  loadRealtimeSeed,
  type SeedConversation,
  type SeedLoaderDeps,
} from '../seed-loader';

const conversation = (over: Partial<SeedConversation> = {}): SeedConversation => ({
  userId: 'u1',
  isShared: false,
  type: 'global',
  contextId: null,
  isActive: true,
  ...over,
});

const history = [
  { role: 'user', content: 'where are my notes?', createdAt: new Date(1) },
  { role: 'assistant', content: 'In your Inbox.', createdAt: new Date(2) },
];

function deps(over: Partial<SeedLoaderDeps> = {}) {
  const warn = vi.fn();
  const base: SeedLoaderDeps = {
    loadConversation: vi.fn(async () => conversation()),
    canAccess: vi.fn(async () => true),
    loadMessages: vi.fn(async () => history),
    logger: { warn },
    ...over,
  };
  return { deps: base, warn };
}

describe('loadRealtimeSeed', () => {
  it('given a bound conversation with history, should build a seed from it', async () => {
    const { deps: d } = deps();

    const seed = await loadRealtimeSeed(d, { userId: 'u1', conversationId: 'conv1' });

    expect(seed).toHaveLength(2);
    expect(seed[0].item.role).toBe('user');
    expect(seed[1].item.content[0]).toEqual({ type: 'text', text: 'In your Inbox.' });
  });

  it('given no conversation bound to the call, should seed nothing without reading anything', async () => {
    const { deps: d } = deps();

    expect(await loadRealtimeSeed(d, { userId: 'u1' })).toEqual([]);
    expect(d.loadConversation).not.toHaveBeenCalled();
  });

  it('given a conversation with no row yet, should seed nothing — that is the ordinary case', async () => {
    // A thread the user just opened has a client-minted id and no row until its
    // first message lands.
    const { deps: d, warn } = deps({ loadConversation: vi.fn(async () => undefined) });

    expect(await loadRealtimeSeed(d, { userId: 'u1', conversationId: 'conv1' })).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('given a history-deleted conversation, should seed nothing', async () => {
    const { deps: d } = deps({
      loadConversation: vi.fn(async () => conversation({ isActive: false })),
    });

    expect(await loadRealtimeSeed(d, { userId: 'u1', conversationId: 'conv1' })).toEqual([]);
  });

  it('given a caller who cannot read the conversation, should seed nothing and say so', async () => {
    const { deps: d, warn } = deps({ canAccess: vi.fn(async () => false) });

    expect(await loadRealtimeSeed(d, { userId: 'intruder', conversationId: 'conv1' })).toEqual([]);
    expect(d.loadMessages).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('given the read fails, should degrade to no history rather than fail the call', async () => {
    // No history is strictly better than no call.
    const { deps: d, warn } = deps({
      loadMessages: vi.fn(async () => {
        throw new Error('db unreachable');
      }),
    });

    expect(await loadRealtimeSeed(d, { userId: 'u1', conversationId: 'conv1' })).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('given caps, should pass them through to the builder', async () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      role: 'user',
      content: `m${index}`,
      createdAt: new Date(index + 1),
    }));
    const { deps: d } = deps({ loadMessages: vi.fn(async () => many) });

    const seed = await loadRealtimeSeed(d, {
      userId: 'u1',
      conversationId: 'conv1',
      maxTurns: 3,
    });

    expect(seed).toHaveLength(3);
    expect(seed[2].item.content[0].text).toBe('m49');
  });

  it('given no caps, should apply the builder defaults rather than pass undefined', async () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      role: 'user',
      content: `m${index}`,
      createdAt: new Date(index + 1),
    }));
    const { deps: d } = deps({ loadMessages: vi.fn(async () => many) });

    const seed = await loadRealtimeSeed(d, { userId: 'u1', conversationId: 'conv1' });

    expect(seed.length).toBeGreaterThan(0);
    expect(seed.length).toBeLessThan(50);
  });
});
