import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import {
  extractStructuredContentFromParts,
  convertDbMessageToUIMessage,
} from '../message-utils';

/**
 * Round-trip persistence for custom `data-*` UI parts (command execution
 * indicators, UX spec §7.1: the indicator persists on the message).
 */

const commandPart = {
  type: 'data-command-execution',
  id: 'cmd-exec-1',
  data: { label: 'release-checklist', status: 'used', entryPageTitle: 'Release Checklist' },
} as unknown as UIMessage['parts'][number];

const textPart = { type: 'text' as const, text: 'On it.' };

describe('extractStructuredContentFromParts — data parts', () => {
  it('captures data-* part payloads and records them in partsOrder', () => {
    const structured = JSON.parse(
      extractStructuredContentFromParts([commandPart, textPart], 'On it.')
    );

    expect(structured.partsOrder).toEqual([
      { index: 0, type: 'data-command-execution', toolCallId: undefined },
      { index: 1, type: 'text', toolCallId: undefined },
    ]);
    expect(structured.dataParts).toEqual([
      {
        type: 'data-command-execution',
        id: 'cmd-exec-1',
        data: { label: 'release-checklist', status: 'used', entryPageTitle: 'Release Checklist' },
      },
    ]);
  });

  it('omits the dataParts field when there are none', () => {
    const structured = JSON.parse(extractStructuredContentFromParts([textPart], 'On it.'));
    expect(structured.dataParts).toBeUndefined();
  });
});

describe('convertDbMessageToUIMessage — data parts', () => {
  it('reconstructs persisted data-* parts in their original position', () => {
    const content = extractStructuredContentFromParts([commandPart, textPart], 'On it.');
    const reconstructed = convertDbMessageToUIMessage({
      id: 'm1',
      pageId: 'p1',
      userId: null,
      role: 'assistant',
      content,
      toolCalls: null,
      toolResults: null,
      createdAt: new Date('2026-06-10T00:00:00Z'),
      isActive: true,
    });

    expect(reconstructed.parts).toEqual([
      {
        type: 'data-command-execution',
        id: 'cmd-exec-1',
        data: { label: 'release-checklist', status: 'used', entryPageTitle: 'Release Checklist' },
      },
      { type: 'text', text: 'On it.' },
    ]);
  });

  it('still reconstructs legacy structured content without dataParts', () => {
    const reconstructed = convertDbMessageToUIMessage({
      id: 'm1',
      pageId: 'p1',
      userId: null,
      role: 'assistant',
      content: JSON.stringify({
        textParts: ['hello'],
        partsOrder: [{ index: 0, type: 'text' }],
        originalContent: 'hello',
      }),
      toolCalls: null,
      toolResults: null,
      createdAt: new Date('2026-06-10T00:00:00Z'),
      isActive: true,
    });

    expect(reconstructed.parts).toEqual([{ type: 'text', text: 'hello' }]);
  });
});
