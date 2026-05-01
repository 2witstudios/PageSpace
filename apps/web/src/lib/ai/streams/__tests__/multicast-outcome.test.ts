/**
 * Outcome integration: drives the producer-side conversion + client-side
 * accumulation + synthesis end-to-end without any test doubles. Proves that
 * a remote stream of (text-delta → tool-call → tool-result → text-delta)
 * produces the *same* UIMessage parts array a co-mounted originator sees,
 * with the tool part landing in 'output-available' state — the binding
 * acceptance criterion for Task 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { chunkToPart } from '../chunkToPart';
import { synthesizeAssistantMessage } from '../synthesizeAssistantMessage';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';

describe('multicast outcome — text + tool-call + tool-result render parity', () => {
  beforeEach(() => {
    usePendingStreamsStore.setState({ streams: new Map() });
  });

  it('given a remote stream of interleaved text and tool chunks, should accumulate into the same parts array a co-mounted originator would see', () => {
    const messageId = 'msg-multicast';
    const { addStream, appendPart } = usePendingStreamsStore.getState();
    const currentParts = (id: string) => usePendingStreamsStore.getState().streams.get(id)?.parts;

    addStream({
      messageId,
      pageId: 'page-1',
      conversationId: 'conv-1',
      triggeredBy: { userId: 'user-author', displayName: 'Author' },
      isOwn: false,
    });

    // Producer-side: AI SDK fullStream chunks, each translated by chunkToPart.
    const producerChunks = [
      { type: 'text-delta', id: 't1', text: 'Let me check ' },
      { type: 'text-delta', id: 't1', text: 'your pages.' },
      { type: 'tool-call', toolCallId: 'tc-list', toolName: 'list_pages', input: { driveId: 'd1' } },
      {
        type: 'tool-result',
        toolCallId: 'tc-list',
        toolName: 'list_pages',
        input: { driveId: 'd1' },
        output: { pages: [{ id: 'p1', title: 'Roadmap' }] },
      },
      { type: 'text-delta', id: 't2', text: 'You have 1 page: Roadmap.' },
      { type: 'finish-step' }, // dropped by chunkToPart
    ];

    for (const chunk of producerChunks) {
      const part = chunkToPart(chunk as never);
      if (part) appendPart(messageId, part);
    }

    const parts = currentParts(messageId)!;
    const synthesized = synthesizeAssistantMessage(messageId, parts);

    expect(synthesized).toEqual({
      id: messageId,
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me check your pages.' },
        {
          type: 'tool-list_pages',
          toolCallId: 'tc-list',
          toolName: 'list_pages',
          state: 'output-available',
          input: { driveId: 'd1' },
          output: { pages: [{ id: 'p1', title: 'Roadmap' }] },
        },
        { type: 'text', text: 'You have 1 page: Roadmap.' },
      ],
    });
  });

  it('given the tool-call frame is delivered before the tool-result, should expose the input-available state mid-flight (so the renderer can show the call before the result lands)', () => {
    const messageId = 'msg-midflight';
    const { addStream, appendPart } = usePendingStreamsStore.getState();
    const currentParts = (id: string) => usePendingStreamsStore.getState().streams.get(id)?.parts;

    addStream({
      messageId,
      pageId: 'page-1',
      conversationId: 'conv-1',
      triggeredBy: { userId: 'user-author', displayName: 'Author' },
      isOwn: false,
    });

    const callPart = chunkToPart({
      type: 'tool-call',
      toolCallId: 'tc1',
      toolName: 'list_pages',
      input: { driveId: 'd1' },
    } as never);
    appendPart(messageId, callPart!);

    const midflight = currentParts(messageId)!;
    expect(midflight).toEqual([
      {
        type: 'tool-list_pages',
        toolCallId: 'tc1',
        toolName: 'list_pages',
        state: 'input-available',
        input: { driveId: 'd1' },
      },
    ]);

    const resultPart = chunkToPart({
      type: 'tool-result',
      toolCallId: 'tc1',
      toolName: 'list_pages',
      input: { driveId: 'd1' },
      output: { pages: [] },
    } as never);
    appendPart(messageId, resultPart!);

    const final = currentParts(messageId)!;
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ state: 'output-available', toolCallId: 'tc1' });
  });

  it('given a buffer-replay sequence (late join applies stored parts) followed by the same final part again, should converge to the same final array (idempotent under double-apply)', () => {
    const messageId = 'msg-replay';
    const { addStream, appendPart } = usePendingStreamsStore.getState();
    const currentParts = (id: string) => usePendingStreamsStore.getState().streams.get(id)?.parts;

    addStream({
      messageId,
      pageId: 'page-1',
      conversationId: 'conv-1',
      triggeredBy: { userId: 'user-author', displayName: 'Author' },
      isOwn: false,
    });

    const finalToolPart = {
      type: 'tool-list_pages',
      toolCallId: 'tc1',
      toolName: 'list_pages',
      state: 'output-available',
      input: { driveId: 'd1' },
      output: { pages: [] },
    } as const;

    // Late join: replay buffer includes the same final part twice (defensive
    // against duplicate delivery from buffer + a live frame that lands at the
    // same instant).
    appendPart(messageId, finalToolPart as never);
    appendPart(messageId, finalToolPart as never);

    expect(currentParts(messageId)!).toEqual([finalToolPart]);
  });
});
