import { describe, it, expect } from 'vitest';
import { extractConversationIdFromBody } from '../extractConversationIdFromBody';

describe('extractConversationIdFromBody', () => {
  it('given a chat POST body, should return its conversationId', () => {
    const body = JSON.stringify({ id: 'chat-1', messages: [], conversationId: 'conv-a' });
    expect(extractConversationIdFromBody(body)).toBe('conv-a');
  });

  it('given a body without conversationId, should return undefined', () => {
    expect(extractConversationIdFromBody(JSON.stringify({ id: 'chat-1', messages: [] }))).toBeUndefined();
  });

  it('given an empty-string conversationId, should return undefined (empty is not a name)', () => {
    expect(extractConversationIdFromBody(JSON.stringify({ conversationId: '' }))).toBeUndefined();
  });

  it('given a non-string conversationId, should return undefined', () => {
    expect(extractConversationIdFromBody(JSON.stringify({ conversationId: 42 }))).toBeUndefined();
  });

  it('given malformed JSON, should return undefined rather than throw', () => {
    expect(extractConversationIdFromBody('{not json')).toBeUndefined();
  });

  it('given a JSON scalar or null body, should return undefined', () => {
    expect(extractConversationIdFromBody('"hello"')).toBeUndefined();
    expect(extractConversationIdFromBody('null')).toBeUndefined();
  });

  it('given a non-string body (FormData, Blob, undefined), should return undefined', () => {
    expect(extractConversationIdFromBody(undefined)).toBeUndefined();
    expect(extractConversationIdFromBody(new Blob(['x']))).toBeUndefined();
  });
});
