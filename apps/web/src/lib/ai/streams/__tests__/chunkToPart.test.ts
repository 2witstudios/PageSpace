import { describe, it, expect } from 'vitest';
import { chunkToPart } from '../chunkToPart';

describe('chunkToPart', () => {
  it('given a text-delta chunk, should return a text part with the same text', () => {
    expect(
      chunkToPart({ type: 'text-delta', id: 't1', text: 'hello' }),
    ).toEqual({ type: 'text', text: 'hello' });
  });

  it('given a tool-call chunk, should return a tool part keyed by toolName with state input-available', () => {
    expect(
      chunkToPart({
        type: 'tool-call',
        toolCallId: 'tc1',
        toolName: 'list_pages',
        input: { driveId: 'd1' },
      }),
    ).toEqual({
      type: 'tool-list_pages',
      toolCallId: 'tc1',
      toolName: 'list_pages',
      state: 'input-available',
      input: { driveId: 'd1' },
    });
  });
});
