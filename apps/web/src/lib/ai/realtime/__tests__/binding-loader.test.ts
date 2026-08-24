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
  sandboxEnabled: false,
  ...over,
});

/**
 * Stands in for whatever `buildVoiceSystemContext` assembled. This module's job
 * is to decide WHAT the call is bound to and hand that over; assembling the
 * instructions is `system-context.ts`, tested there.
 */
const CALL_CONTEXT = {
  instructions: '# PAGESPACE AI\n\n<<SHARED>>\n\n# THIS IS A VOICE CALL',
  tools: [{ type: 'function' as const, name: 'read_page', description: '', parameters: {} }],
};

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
    buildCallContext: vi.fn(async () => CALL_CONTEXT),
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
  it('given any call, should carry the assembled system prompt and the spoken override', async () => {
    const { deps: d } = deps();

    const { instructions } = await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(instructions).toContain('<<SHARED>>');
    expect(instructions).toContain('# THIS IS A VOICE CALL');
  });

  it('given a page agent, should describe it to the assembler as an agent', async () => {
    // What the prompt says about tools, memory and persona all hangs off this:
    // handing the assembler no agent would silently build the Global
    // Assistant's prompt for a call the UI says is talking to a named one.
    const systemPrompt = 'Answer only in limericks.';
    const { deps: d } = deps({
      loadConversation: vi.fn(async () => pageConversation()),
      loadAgentPage: vi.fn(async () => agentPage({ systemPrompt, enabledTools: ['read_page'] })),
    });

    await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(d.buildCallContext).toHaveBeenCalledWith({
      userId: 'u1',
      conversationId: 'conv1',
      conversation: { type: 'page', contextId: 'agent1' },
      agent: {
        pageId: 'agent1',
        title: 'Release Notes Bot',
        systemPrompt,
        enabledTools: ['read_page'],
        // The agent's whole tool configuration travels together — the switch is
        // part of it, not a separate concern the call can skip (issue #2460).
        sandboxEnabled: false,
      },
    });
  });

  it('given a conversation with no agent, should pass its coordinates but no agent', async () => {
    const { deps: d } = deps();

    await loadVoiceBinding(d, { userId: 'u1', conversationId: 'conv1' });

    expect(d.buildCallContext).toHaveBeenCalledWith({
      userId: 'u1',
      conversationId: 'conv1',
      conversation: { type: 'global', contextId: null },
    });
  });

  it('given an unbound call, should still assemble a prompt for it', async () => {
    // An unbound call talks to the Global Assistant — the same one the
    // dashboard talks to — so it is a real call, not a degraded one.
    const { deps: d } = deps();

    const { instructions } = await loadVoiceBinding(d, { userId: 'u1' });

    expect(d.buildCallContext).toHaveBeenCalledWith({ userId: 'u1' });
    expect(instructions).toContain('<<SHARED>>');
    expect(instructions).toContain('# THIS IS A VOICE CALL');
  });

  it('given a conversation the caller cannot read, should assemble as if unbound', async () => {
    // No history, and nothing derived from a thread this caller may not see.
    const { deps: d } = deps({ canAccess: vi.fn(async () => false) });

    const { instructions, seed } = await loadVoiceBinding(d, {
      userId: 'u1',
      conversationId: 'conv1',
    });

    expect(seed).toEqual([]);
    expect(d.buildCallContext).toHaveBeenCalledWith({ userId: 'u1' });
    expect(instructions).toContain('# THIS IS A VOICE CALL');
  });
});
