import { describe, it, expect } from 'vitest';
import { buildGlobalChatRequestBody } from '../global-chat-request-body';

const baseParams = {
  conversationId: 'conv-123',
  isReadOnly: false,
  webSearchEnabled: true,
  imageGenEnabled: false,
  showPageTree: false,
  selectedProvider: 'openai',
  selectedModel: 'openai/gpt-5.3-chat',
};

describe('buildGlobalChatRequestBody', () => {
  it('given a conversationId, should include it in the returned body', () => {
    const body = buildGlobalChatRequestBody(baseParams);
    expect(body.conversationId).toBe('conv-123');
  });

  it('passes imageGenEnabled through to the body', () => {
    expect(buildGlobalChatRequestBody({ ...baseParams, imageGenEnabled: true }).imageGenEnabled).toBe(true);
    expect(buildGlobalChatRequestBody(baseParams).imageGenEnabled).toBe(false);
  });

  it('given null conversationId, should pass null through rather than omitting the field', () => {
    const body = buildGlobalChatRequestBody({ ...baseParams, conversationId: null });
    expect(body.conversationId).toBeNull();
  });

  it('given a different conversationId across two calls, should reflect the new value each time (not frozen)', () => {
    const first = buildGlobalChatRequestBody({ ...baseParams, conversationId: 'conv-a' });
    const second = buildGlobalChatRequestBody({ ...baseParams, conversationId: 'conv-b' });
    expect(first.conversationId).toBe('conv-a');
    expect(second.conversationId).toBe('conv-b');
  });

  it('given no locationContext, should default to undefined', () => {
    const body = buildGlobalChatRequestBody(baseParams);
    expect(body.locationContext).toBeUndefined();
  });

  it('given a null locationContext, should default to undefined', () => {
    const body = buildGlobalChatRequestBody({ ...baseParams, locationContext: null });
    expect(body.locationContext).toBeUndefined();
  });

  it('given a locationContext object, should pass it through', () => {
    const locationContext = { currentPage: { id: 'p1', title: 'Page', type: 'Document', path: '/p1' } };
    const body = buildGlobalChatRequestBody({ ...baseParams, locationContext });
    expect(body.locationContext).toBe(locationContext);
  });

  it('given no mcpTools, should default to undefined', () => {
    const body = buildGlobalChatRequestBody(baseParams);
    expect(body.mcpTools).toBeUndefined();
  });

  it('given an empty mcpTools array, should default to undefined', () => {
    const body = buildGlobalChatRequestBody({ ...baseParams, mcpTools: [] });
    expect(body.mcpTools).toBeUndefined();
  });

  it('given a non-empty mcpTools array, should pass it through', () => {
    const tools = [{ name: 'tool-1' }];
    const body = buildGlobalChatRequestBody({ ...baseParams, mcpTools: tools });
    expect(body.mcpTools).toBe(tools);
  });

  it('given the same inputs, should produce equal output on every call (purity)', () => {
    const a = buildGlobalChatRequestBody(baseParams);
    const b = buildGlobalChatRequestBody(baseParams);
    expect(a).toEqual(b);
  });

  it('should pass through isReadOnly, webSearchEnabled, showPageTree, selectedProvider, selectedModel unchanged', () => {
    const body = buildGlobalChatRequestBody(baseParams);
    expect(body.isReadOnly).toBe(false);
    expect(body.webSearchEnabled).toBe(true);
    expect(body.showPageTree).toBe(false);
    expect(body.selectedProvider).toBe('openai');
    expect(body.selectedModel).toBe('openai/gpt-5.3-chat');
  });
});
