import { describe, it, expect, beforeEach, vi } from 'vitest';
import { conversationState, classifyConversationLoadResponse } from '../conversation-state';

vi.mock('@/lib/auth/auth-fetch', () => ({
  post: vi.fn(),
  fetchWithAuth: vi.fn(),
}));

import { post } from '@/lib/auth/auth-fetch';

describe('conversationState agent methods', () => {
  beforeEach(() => {
    document.cookie = 'activeAgentId=; max-age=0; path=/';
    document.cookie = 'activeConversationId=; max-age=0; path=/';
    vi.clearAllMocks();
  });

  it('should set and get agent ID', () => {
    conversationState.setActiveAgentId('agent_123');
    expect(conversationState.getActiveAgentId()).toBe('agent_123');
  });

  it('should clear agent when set to null', () => {
    conversationState.setActiveAgentId('agent_123');
    expect(conversationState.getActiveAgentId()).toBe('agent_123');

    conversationState.setActiveAgentId(null);
    expect(conversationState.getActiveAgentId()).toBeNull();
  });
});

describe('conversationState.createAndSetActiveConversation', () => {
  beforeEach(() => {
    document.cookie = 'activeConversationId=; max-age=0; path=/';
    vi.clearAllMocks();
  });

  it('does NOT call post() or any network fetch', async () => {
    await conversationState.createAndSetActiveConversation({ type: 'global' });
    expect(post).not.toHaveBeenCalled();
  });

  it('returns an object with a non-empty string id', async () => {
    const result = await conversationState.createAndSetActiveConversation({ type: 'global' });
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
  });

  it('returns id matching CUID2 format', async () => {
    const result = await conversationState.createAndSetActiveConversation({ type: 'global' });
    expect(result.id).toMatch(/^[a-z0-9]{24,}$/);
  });

  it('returns null title and null lastMessageAt', async () => {
    const result = await conversationState.createAndSetActiveConversation({ type: 'global' });
    expect(result.title).toBeNull();
    expect(result.lastMessageAt).toBeNull();
  });

  it('returns the requested type', async () => {
    const result = await conversationState.createAndSetActiveConversation({ type: 'global' });
    expect(result.type).toBe('global');
  });

  it('persists the generated id to the activeConversationId cookie', async () => {
    const result = await conversationState.createAndSetActiveConversation({ type: 'global' });
    expect(conversationState.getActiveConversationId()).toBe(result.id);
  });

  it('generates a different id on each call', async () => {
    const a = await conversationState.createAndSetActiveConversation();
    const b = await conversationState.createAndSetActiveConversation();
    expect(a.id).not.toBe(b.id);
  });
});

describe('classifyConversationLoadResponse', () => {
  it('given status 200, returns "ok"', () => {
    expect(classifyConversationLoadResponse(200)).toBe('ok');
  });

  it('given status 201, returns "ok"', () => {
    expect(classifyConversationLoadResponse(201)).toBe('ok');
  });

  it('given status 404, returns "not-found"', () => {
    expect(classifyConversationLoadResponse(404)).toBe('not-found');
  });

  it('given status 500, returns "error"', () => {
    expect(classifyConversationLoadResponse(500)).toBe('error');
  });

  it('given status 403, returns "error"', () => {
    expect(classifyConversationLoadResponse(403)).toBe('error');
  });

  it('given status 401, returns "error"', () => {
    expect(classifyConversationLoadResponse(401)).toBe('error');
  });
});
