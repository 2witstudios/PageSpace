import { describe, it, expect } from 'vitest';
import { createUIMessageStream } from 'ai';
import type { UIMessage, UIMessageChunk, ChatTransport } from 'ai';
import { Chat } from '@ai-sdk/react';

/**
 * Pins two SDK behaviors the store-first design depends on (PR 3 board,
 * "Assumption A"): the server-issued assistant id always wins over the
 * client-generated id, including the pre-`start` data-part edge case where
 * that only holds by reference-identity luck in `ReactChatState.pushMessage`.
 * If either behavior regresses on an SDK bump, these tests turn it into a
 * red CI run instead of a screen flash.
 */

const readAll = async (stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> => {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
};

describe('createUIMessageStream server-id injection', () => {
  it('given history ending with a user message, should stamp the start chunk with the generated id', async () => {
    const stream = createUIMessageStream({
      generateId: () => 'server-assistant-id',
      originalMessages: [{ id: 'u1', role: 'user', parts: [] }] as UIMessage[],
      execute: ({ writer }) => {
        writer.write({ type: 'start' });
        writer.write({ type: 'finish' });
      },
    });

    const chunks = await readAll(stream);
    const start = chunks.find((c) => c.type === 'start');
    expect(start).toMatchObject({ type: 'start', messageId: 'server-assistant-id' });
  });

  it('given history ending with an assistant message, should override the generated id with that message id (continuation)', async () => {
    const stream = createUIMessageStream({
      generateId: () => 'server-assistant-id',
      originalMessages: [
        { id: 'u1', role: 'user', parts: [] },
        { id: 'a-existing', role: 'assistant', parts: [] },
      ] as UIMessage[],
      execute: ({ writer }) => {
        writer.write({ type: 'start' });
        writer.write({ type: 'finish' });
      },
    });

    const chunks = await readAll(stream);
    const start = chunks.find((c) => c.type === 'start');
    expect(start).toMatchObject({ type: 'start', messageId: 'a-existing' });
  });

  it('given a start chunk that already carries a messageId, should not override it', async () => {
    const stream = createUIMessageStream({
      generateId: () => 'server-assistant-id',
      originalMessages: [{ id: 'u1', role: 'user', parts: [] }] as UIMessage[],
      execute: ({ writer }) => {
        writer.write({ type: 'start', messageId: 'explicit-id' });
        writer.write({ type: 'finish' });
      },
    });

    const chunks = await readAll(stream);
    const start = chunks.find((c) => c.type === 'start');
    expect(start).toMatchObject({ type: 'start', messageId: 'explicit-id' });
  });
});

describe('AbstractChat adopts the server-issued assistant id', () => {
  const makeChat = (chunks: UIMessageChunk[]) => {
    const transport: ChatTransport<UIMessage> = {
      sendMessages: async () =>
        new ReadableStream<UIMessageChunk>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      reconnectToStream: async () => null,
    };
    return new Chat({ messages: [], transport });
  };

  it('given a normal stream (start arrives first), should push the assistant message under the server id', async () => {
    const chat = makeChat([
      { type: 'start', messageId: 'server-assistant-id' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'hello' },
      { type: 'text-end', id: 't1' },
      { type: 'finish' },
    ]);

    await chat.sendMessage({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] });

    expect(chat.messages).toHaveLength(2);
    const assistant = chat.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.id).toBe('server-assistant-id');
  });

  it('given a data part before the start chunk, should still converge to exactly one assistant message under the server id', async () => {
    const chat = makeChat([
      { type: 'data-commandExecution', id: 'cmd-1', data: { status: 'running' } },
      { type: 'start', messageId: 'server-assistant-id' },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'hello' },
      { type: 'text-end', id: 't1' },
      { type: 'finish' },
    ]);

    await chat.sendMessage({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] });

    const assistantMessages = chat.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].id).toBe('server-assistant-id');
    expect(assistantMessages[0].parts.some((p) => p.type === 'data-commandExecution')).toBe(true);
  });
});
