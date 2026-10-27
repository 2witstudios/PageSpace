import { describe, it, expect } from 'vitest';
import { buildSessionChatRequestBody } from '../build-session-chat-request';

const CONTEXT_REF = { routeType: 'page' as const, pageId: 'page-1', driveId: 'drive-1' };

describe('buildSessionChatRequestBody', () => {
  it('shapes chatId as the agentId and conversationId as-is — no session-binding field', () => {
    const body = buildSessionChatRequestBody({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      isReadOnly: false,
      webSearchEnabled: false,
      imageGenEnabled: false,
      contextRef: CONTEXT_REF,
    });

    expect(body.chatId).toBe('agent-1');
    expect(body.conversationId).toBe('conv-1');
    expect(body).not.toHaveProperty('sessionId');
    expect(body).not.toHaveProperty('machineId');
  });

  it('carries the agent\'s own provider/model/systemPrompt/enabledTools through untouched', () => {
    const body = buildSessionChatRequestBody({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      isReadOnly: false,
      webSearchEnabled: true,
      imageGenEnabled: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      systemPrompt: 'You are helpful.',
      enabledTools: ['search', 'bash'],
      contextRef: CONTEXT_REF,
    });

    expect(body).toEqual(
      expect.objectContaining({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        systemPrompt: 'You are helpful.',
        enabledTools: ['search', 'bash'],
        webSearchEnabled: true,
        imageGenEnabled: true,
      }),
    );
  });

  it('passes isReadOnly and contextRef through unchanged', () => {
    const body = buildSessionChatRequestBody({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      isReadOnly: true,
      webSearchEnabled: false,
      imageGenEnabled: false,
      contextRef: CONTEXT_REF,
    });

    expect(body.isReadOnly).toBe(true);
    expect(body.contextRef).toBe(CONTEXT_REF);
  });

  it('omits provider/model/systemPrompt/enabledTools entirely when not supplied, rather than writing them as null', () => {
    const body = buildSessionChatRequestBody({
      agentId: 'agent-1',
      conversationId: 'conv-1',
      isReadOnly: false,
      webSearchEnabled: false,
      imageGenEnabled: false,
      contextRef: CONTEXT_REF,
    });

    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('systemPrompt');
    expect(body).not.toHaveProperty('enabledTools');
  });

  it('is pure — same inputs produce a deep-equal (but distinct) object', () => {
    const params = {
      agentId: 'agent-1',
      conversationId: 'conv-1',
      isReadOnly: false,
      webSearchEnabled: false,
      imageGenEnabled: false,
      contextRef: CONTEXT_REF,
    };
    const a = buildSessionChatRequestBody(params);
    const b = buildSessionChatRequestBody(params);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
