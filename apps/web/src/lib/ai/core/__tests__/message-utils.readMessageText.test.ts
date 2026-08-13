/**
 * Reading a stored message's words back out.
 *
 * `messages.content` is not prose. Any row saved with parts — every typed
 * assistant turn — stores a JSON envelope there, and a plain `select` returns
 * the envelope. Anything that wants the words and reads the column directly
 * gets `{"textParts":["Here they are."],…}` and treats it as something someone
 * said. The voice seed did exactly that.
 */

import { describe, expect, it } from 'vitest';
import { readMessageText } from '../message-utils';
import { serializeMessageRowToMessages } from '../../openai-api/v1-conversations';

const structured = (over: Record<string, unknown>) =>
  JSON.stringify({ textParts: [], partsOrder: [], originalContent: '', ...over });

describe('readMessageText', () => {
  it('given a structured row, should return the words rather than the envelope', () => {
    const content = structured({
      textParts: ['Here they are.'],
      partsOrder: [{ index: 0, type: 'text' }],
      originalContent: 'Here they are.',
    });

    expect(readMessageText(content)).toBe('Here they are.');
  });

  it('given a TOOL row, should return nothing — no words were said', () => {
    // A voice tool call is persisted as its own row and renders from its parts.
    // Returning the envelope here is what would seed the next call with JSON in
    // the assistant's voice.
    const content = structured({
      partsOrder: [{ index: 0, type: 'tool-read_page', toolCallId: 'call_1' }],
    });

    expect(readMessageText(content)).toBe('');
  });

  it('given several text parts and no original body, should join them', () => {
    expect(readMessageText(JSON.stringify({ textParts: ['One. ', 'Two.'], partsOrder: [] }))).toBe(
      'One. Two.',
    );
  });

  it('should be the ONLY reader — the v1 conversations API decodes through it too', () => {
    // It had a private copy of this. Two functions decoding the same envelope
    // are two that can disagree about what a message says, on a surface whose
    // whole job is reporting what a message says.
    const envelope = structured({
      textParts: ['Here they are.'],
      originalContent: 'Here they are.',
    });

    const [message] = serializeMessageRowToMessages({
      id: 'm1',
      role: 'assistant',
      content: envelope,
      toolCalls: null,
      toolResults: null,
      createdAt: new Date(0),
      isActive: true,
    });

    expect((message as { content: string | null }).content).toBe('Here they are.');
  });

  it('given a plain legacy row, should pass it through untouched', () => {
    // Rows written before structured content, and every user turn.
    expect(readMessageText('just text')).toBe('just text');
  });

  it('given JSON that is not our envelope, should treat it as text', () => {
    // A message whose body happens to be JSON is still a message body.
    expect(readMessageText('{"hello":"world"}')).toBe('{"hello":"world"}');
  });

  it('given nothing, should return nothing rather than throw', () => {
    expect(readMessageText(null)).toBe('');
    expect(readMessageText(undefined)).toBe('');
    expect(readMessageText('')).toBe('');
  });

  it('given an envelope with no text parts but an original body, should fall back to it', () => {
    expect(readMessageText(structured({ originalContent: 'said this' }))).toBe('said this');
  });
});
