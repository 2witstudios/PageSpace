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

  it('given a tool-result chunk, should return a tool part with state output-available carrying input and output', () => {
    expect(
      chunkToPart({
        type: 'tool-result',
        toolCallId: 'tc1',
        toolName: 'list_pages',
        input: { driveId: 'd1' },
        output: { pages: [{ id: 'p1' }] },
      }),
    ).toEqual({
      type: 'tool-list_pages',
      toolCallId: 'tc1',
      toolName: 'list_pages',
      state: 'output-available',
      input: { driveId: 'd1' },
      output: { pages: [{ id: 'p1' }] },
    });
  });

  it('given a tool-call chunk missing toolName, should return null (cannot derive type prefix)', () => {
    expect(
      chunkToPart({
        type: 'tool-call',
        toolCallId: 'tc1',
        input: { driveId: 'd1' },
      } as never),
    ).toBeNull();
  });

  it('given a tool-call chunk missing toolCallId, should return null (idempotency key required)', () => {
    expect(
      chunkToPart({
        type: 'tool-call',
        toolName: 'list_pages',
        input: { driveId: 'd1' },
      } as never),
    ).toBeNull();
  });

  it('given a tool-result chunk missing toolName, should return null', () => {
    expect(
      chunkToPart({
        type: 'tool-result',
        toolCallId: 'tc1',
        input: { driveId: 'd1' },
        output: { pages: [] },
      } as never),
    ).toBeNull();
  });

  it('given a tool-result chunk missing toolCallId, should return null', () => {
    expect(
      chunkToPart({
        type: 'tool-result',
        toolName: 'list_pages',
        input: { driveId: 'd1' },
        output: { pages: [] },
      } as never),
    ).toBeNull();
  });

  it.each([
    ['start'],
    ['start-step'],
    ['finish-step'],
    ['finish'],
    ['abort'],
    ['error'],
    ['raw'],
    ['reasoning-delta'],
    ['tool-input-start'],
    ['tool-input-delta'],
    ['tool-input-end'],
    ['source'],
    ['file'],
  ])('given a %s chunk, should return null (out of v1 multicast scope)', (type) => {
    expect(chunkToPart({ type } as never)).toBeNull();
  });
});
