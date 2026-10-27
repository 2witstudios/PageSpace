import { describe, it, expect } from 'vitest';
import type { UIMessage, UIMessageChunk, ChatTransport } from 'ai';
import { Chat } from '@ai-sdk/react';

/**
 * Pins "Assumption B" from the PR 3 board: a client-minted user-message id
 * only survives through the parts-form `sendMessage({ id, role: 'user',
 * parts })` call. The `{ text, files }` shorthand rebuilds the message from
 * scratch and always mints via `generateId()` — pinning the failure here
 * means an SDK fix that starts honoring an id on the shorthand flips this
 * test visibly instead of silently changing dedup behavior.
 */

const makeCapturingTransport = () => {
  const calls: UIMessage[][] = [];
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async ({ messages }) => {
      calls.push(messages);
      return new ReadableStream<UIMessageChunk>({
        start(controller) {
          controller.enqueue({ type: 'start', messageId: 'server-assistant-id' });
          controller.enqueue({ type: 'finish' });
          controller.close();
        },
      });
    },
    reconnectToStream: async () => null,
  };
  return { transport, calls };
};

describe('client-minted user-message id', () => {
  it('given the parts-form send with a caller id, should carry that id into the transport request body', async () => {
    const { transport, calls } = makeCapturingTransport();
    const chat = new Chat({ messages: [], transport });

    await chat.sendMessage({ id: 'client-minted-id', role: 'user', parts: [{ type: 'text', text: 'hi' }] });

    expect(calls).toHaveLength(1);
    const lastMessageSent = calls[0][calls[0].length - 1];
    expect(lastMessageSent.id).toBe('client-minted-id');
    expect(lastMessageSent.role).toBe('user');
  });

  it('given the parts-form send, should also push the message into local state under the caller id', async () => {
    const { transport } = makeCapturingTransport();
    const chat = new Chat({ messages: [], transport });

    await chat.sendMessage({ id: 'client-minted-id', role: 'user', parts: [{ type: 'text', text: 'hi' }] });

    expect(chat.messages[0].id).toBe('client-minted-id');
  });

  it('given the {text} shorthand, should drop any id property and mint a fresh one via generateId', async () => {
    const { transport } = makeCapturingTransport();
    let counter = 0;
    const chat = new Chat({ messages: [], transport, generateId: () => `generated-${++counter}` });

    // The shorthand's type has no `id` member (ai/dist/index.d.ts:3926-3941) —
    // this cast simulates a caller mistakenly attaching one at the JS level,
    // which is exactly the failure mode this test pins.
    const shorthandWithId = { text: 'hi', id: 'should-be-dropped' } as unknown as { text: string };
    await chat.sendMessage(shorthandWithId);

    expect(chat.messages[0].id).toMatch(/^generated-\d+$/);
    expect(chat.messages[0].id).not.toBe('should-be-dropped');
  });

  it('given the {files} shorthand, should also drop any id property and mint a fresh one', async () => {
    const { transport } = makeCapturingTransport();
    let counter = 0;
    const chat = new Chat({ messages: [], transport, generateId: () => `generated-${++counter}` });

    const shorthandWithId = { files: [], id: 'should-be-dropped' } as unknown as {
      files: [];
    };
    await chat.sendMessage(shorthandWithId);

    expect(chat.messages[0].id).toMatch(/^generated-\d+$/);
    expect(chat.messages[0].id).not.toBe('should-be-dropped');
  });
});
