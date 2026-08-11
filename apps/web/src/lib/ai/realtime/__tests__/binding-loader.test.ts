/**
 * Binding tests.
 *
 * Two things are being checked here and they pull in opposite directions. The
 * seed half must DEGRADE — no history beats no call — while the assistant half
 * must not: the agent identity these produce is what tool execution authorizes
 * as, so a binding that guesses is worse than one that returns nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  loadVoiceBinding,
  type AgentPage,
  type BindingLoaderDeps,
  type SeedConversation,
} from '../binding-loader';

const conversation = (over: Partial<SeedConversation> = {}): SeedConversation => ({
  userId: 'u1',
  isShared: false,
  type: 'global',
  contextId: null,
  isActive: true,
  ...over,
});

const pageConversation = (over: Partial<SeedConversation> = {}) =>
  conversation({ type: 'page', contextId: 'agent1', ...over });

const agentPage = (over: Partial<AgentPage> = {}): AgentPage => ({
  id: 'agent1',
  type: 'AI_CHAT',
  title: 'Release Notes Bot',
  systemPrompt: null,
  enabledTools: null,
  ...over,
});

const history = [
  { role: 'user', content: 'where are my notes?', createdAt: new Date(1) },
  { role: 'assistant', content: 'In your Inbox.', createdAt: new Date(2) },
];

function deps(over: Partial<BindingLoaderDeps> = {}) {
  const warn = vi.fn();
  const base: BindingLoaderDeps = {
    loadConversation: vi.fn(async () => conversation()),
    canAccess: vi.fn(async () => true),
    loadMessages: vi.fn(async () => history),
    loadAgentPage: vi.fn(async () => agentPage()),
    logger: { warn },
    ...over,
  };
  return { deps: base, warn };
}

describe('loadVoiceBinding — the seed', () => {
  it('given a bound conversation with history, should build a seed from it', async () => {
    const { deps: d } = deps();

    const { seed } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(seed).toHaveLength(2);
    expect(seed[0].item.role).toBe('user');
    expect(seed[1].item.content[0]).toEqual({ type: 'text', text: 'In your Inbox.' });
  });

  it('given no conversation bound to the call, should bind nothing without reading anything', async () => {
    const { deps: d } = deps();

    const binding = await loadVoiceBinding(d, { userId: 'u1' });

    expect(binding.seed).toEqual([]);
    expect(binding.assistant).toBeUndefined();
    expect(d.loadConversation).not.toHaveBeenCalled();
  });

  it('given a conversation with no row yet, should bind nothing — that is the ordinary case', async () => {
    // A thread the user just opened has a client-minted id and no row until its
    // first message lands.
    const { deps: d, warn } = deps({ loadConversation: vi.fn(async () => undefined) });

    const binding = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(binding.seed).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('given a history-deleted conversation, should bind nothing', async () => {
    const { deps: d } = deps({
      loadConversation: vi.fn(async () => conversation({ isActive: false })),
    });

    const binding = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(binding.seed).toEqual([]);
  });

  it('given the read fails, should degrade to no history rather than fail the call', async () => {
    // No history is strictly better than no call.
    const { deps: d, warn } = deps({
      loadMessages: vi.fn(async () => {
        throw new Error('db unreachable');
      }),
    });

    const binding = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(binding.seed).toEqual([]);
    expect(binding.instructions).not.toBe('');
    expect(warn).toHaveBeenCalled();
  });

  it('given caps, should pass them through to the builder', async () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      role: 'user',
      content: `m${index}`,
      createdAt: new Date(index + 1),
    }));
    const { deps: d } = deps({ loadMessages: vi.fn(async () => many) });

    const { seed } = await loadVoiceBinding(d, {
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

    const { seed } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(seed.length).toBeGreaterThan(0);
    expect(seed.length).toBeLessThan(50);
  });
});

describe('loadVoiceBinding — the assistant', () => {
  it('given a page conversation on an AI_CHAT page, should resolve THAT page as the acting agent', async () => {
    // The agent comes from the conversation's own `contextId`, which the access
    // check above has already authorized — never from anything the browser said.
    const { deps: d } = deps({
      loadConversation: vi.fn(async () => pageConversation()),
      loadAgentPage: vi.fn(async () => agentPage({ enabledTools: ['read_page'] })),
    });

    const { assistant } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(assistant).toEqual({
      agentPageId: 'agent1',
      agentTitle: 'Release Notes Bot',
      enabledTools: ['read_page'],
    });
  });

  it("given an agent with an empty allowlist, should carry [] rather than collapse it to unrestricted", async () => {
    // `[]` is "its owner switched every tool off" and null is "never
    // restricted". Reading the first as the second re-grants the whole registry.
    const { deps: d } = deps({
      loadConversation: vi.fn(async () => pageConversation()),
      loadAgentPage: vi.fn(async () => agentPage({ enabledTools: [] })),
    });

    const { assistant } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(assistant?.enabledTools).toEqual([]);
  });

  it('given a GLOBAL conversation, should resolve no agent and not go looking for a page', async () => {
    const { deps: d } = deps();

    const { assistant } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(assistant).toBeUndefined();
    expect(d.loadAgentPage).not.toHaveBeenCalled();
  });

  it('given a conversation on a NON-agent page, should not treat that page as an agent', async () => {
    // Every page conversation puts its page in `contextId`, and a document is
    // not an agent: no driveAgentMembers row can exist for it, so authorizing
    // as it would deny everything.
    const { deps: d } = deps({
      loadConversation: vi.fn(async () => pageConversation({ contextId: 'doc1' })),
      loadAgentPage: vi.fn(async () => agentPage({ id: 'doc1', type: 'DOCUMENT' })),
    });

    const { assistant } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(assistant).toBeUndefined();
  });

  it('given an agent page that no longer exists, should resolve no agent', async () => {
    const { deps: d } = deps({
      loadConversation: vi.fn(async () => pageConversation()),
      loadAgentPage: vi.fn(async () => undefined),
    });

    const { assistant } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(assistant).toBeUndefined();
  });

  it('given a caller who cannot read the conversation, should resolve NO agent and read no messages', async () => {
    // The agent is only as authorized as the conversation it hangs off. A
    // refused conversation must not still hand back an identity to act as.
    const { deps: d, warn } = deps({
      loadConversation: vi.fn(async () => pageConversation()),
      canAccess: vi.fn(async () => false),
    });

    const binding = await loadVoiceBinding(d, { userId: 'intruder', conversationId: 'conv1' });

    expect(binding.assistant).toBeUndefined();
    expect(binding.seed).toEqual([]);
    expect(d.loadMessages).not.toHaveBeenCalled();
    expect(d.loadAgentPage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe('loadVoiceBinding — the instructions', () => {
  it('given any call, should say it is a spoken conversation', async () => {
    const { deps: d } = deps();

    const { instructions } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(instructions).toContain('heard, not read');
  });

  it("given a page agent with its own prompt, should carry that prompt VERBATIM", async () => {
    const systemPrompt = 'Answer only in limericks. Never mention the weather.';
    const { deps: d } = deps({
      loadConversation: vi.fn(async () => pageConversation()),
      loadAgentPage: vi.fn(async () => agentPage({ systemPrompt })),
    });

    const { instructions } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(instructions).toContain(systemPrompt);
    expect(instructions).toContain('Release Notes Bot');
  });

  it('given a page agent with NO prompt, should still name it so it is the assistant the user picked', async () => {
    const { deps: d } = deps({
      loadConversation: vi.fn(async () => pageConversation()),
      loadAgentPage: vi.fn(async () => agentPage({ systemPrompt: null })),
    });

    const { instructions } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(instructions).toContain('Release Notes Bot');
  });

  it('given a whitespace-only prompt, should treat it as no prompt rather than send blanks', async () => {
    const { deps: d } = deps({
      loadConversation: vi.fn(async () => pageConversation()),
      loadAgentPage: vi.fn(async () => agentPage({ systemPrompt: '   \n  ' })),
    });

    const { instructions } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(instructions).toContain('PageSpace');
    expect(instructions).not.toMatch(/instructions follow/);
  });
});
