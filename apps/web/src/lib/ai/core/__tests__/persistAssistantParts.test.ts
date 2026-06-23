import { describe, it, expect } from 'vitest';
import { buildAssistantPersistencePayload } from '../persistAssistantParts';
import type { UIMessagePart } from '../stream-multicast-registry';

const textPart = (text: string): UIMessagePart => ({ type: 'text', text });

const toolCallPart = (): UIMessagePart =>
  ({
    type: 'tool-search',
    toolCallId: 'tc-1',
    toolName: 'search',
    input: { q: 'hello' },
    state: 'input-available',
  }) as UIMessagePart;

const toolResultPart = (): UIMessagePart =>
  ({
    type: 'tool-search',
    toolCallId: 'tc-1',
    toolName: 'search',
    input: { q: 'hello' },
    output: { results: [] },
    state: 'output-available',
  }) as UIMessagePart;

describe('buildAssistantPersistencePayload', () => {
  it('text-only parts: extracts content and produces undefined tool fields', () => {
    const parts: UIMessagePart[] = [textPart('Hello'), textPart(' world')];
    const payload = buildAssistantPersistencePayload('msg-1', parts);

    expect(payload.content).toBe('Hello world');
    expect(payload.toolCalls).toBeUndefined();
    expect(payload.toolResults).toBeUndefined();
    expect(payload.uiMessage.id).toBe('msg-1');
    expect(payload.uiMessage.role).toBe('assistant');
    expect(payload.uiMessage.parts).toHaveLength(2);
  });

  it('text + tool parts: extracts content and tool calls/results', () => {
    // extractToolCalls maps ALL tool-invocation parts (both call-only and result parts)
    // extractToolResults filters to just output-available/output-error state parts
    const parts: UIMessagePart[] = [textPart('Here'), toolCallPart(), toolResultPart()];
    const payload = buildAssistantPersistencePayload('msg-2', parts);

    expect(payload.content).toBe('Here');
    expect(payload.toolCalls).toHaveLength(2); // both the call part and the result part
    expect(payload.toolCalls![0].toolCallId).toBe('tc-1');
    expect(payload.toolCalls![0].toolName).toBe('search');
    expect(payload.toolResults).toHaveLength(1); // only the output-available part
    expect(payload.toolResults![0].toolCallId).toBe('tc-1');
    expect(payload.toolResults![0].state).toBe('output-available');
    expect(payload.uiMessage.parts).toHaveLength(3);
  });

  it('empty parts array: returns empty content and undefined tool fields', () => {
    const payload = buildAssistantPersistencePayload('msg-3', []);

    expect(payload.content).toBe('');
    expect(payload.toolCalls).toBeUndefined();
    expect(payload.toolResults).toBeUndefined();
    expect(payload.uiMessage.id).toBe('msg-3');
    expect(payload.uiMessage.parts).toHaveLength(0);
  });

  it('does not mutate the input parts array', () => {
    const parts: UIMessagePart[] = [textPart('immutable')];
    buildAssistantPersistencePayload('msg-4', parts);

    expect(parts).toHaveLength(1);
  });
});
