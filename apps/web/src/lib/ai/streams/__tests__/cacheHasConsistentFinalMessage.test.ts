import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { cacheHasConsistentFinalMessage } from '../cacheHasConsistentFinalMessage';

const row = (id: string, status?: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text: 'reply' }], ...(status ? { status } : {}) }) as UIMessage;

describe('cacheHasConsistentFinalMessage', () => {
  it('given a cached complete row and a clean completion, should be final', () => {
    expect(cacheHasConsistentFinalMessage([row('m1', 'complete')], 'm1', false)).toBe(true);
  });

  it('given a cached complete row and an aborted completion, should still be final (the sender drained the full body)', () => {
    expect(cacheHasConsistentFinalMessage([row('m1', 'complete')], 'm1', true)).toBe(true);
  });

  it('given a cached interrupted row and an ABORTED completion, should be final (server confirms the stop)', () => {
    expect(cacheHasConsistentFinalMessage([row('m1', 'interrupted')], 'm1', true)).toBe(true);
  });

  it('given a cached interrupted row and a CLEAN completion, should NOT be final (the server outran the abort — the full reply must be reloaded)', () => {
    expect(cacheHasConsistentFinalMessage([row('m1', 'interrupted')], 'm1', false)).toBe(false);
  });

  it('given a cached streaming placeholder, should never be final', () => {
    expect(cacheHasConsistentFinalMessage([row('m1', 'streaming')], 'm1', false)).toBe(false);
    expect(cacheHasConsistentFinalMessage([row('m1', 'streaming')], 'm1', true)).toBe(false);
  });

  it('given a cached row without a status, should not be final (unknown provenance — let the reload fetch DB truth)', () => {
    expect(cacheHasConsistentFinalMessage([row('m1')], 'm1', false)).toBe(false);
  });

  it('given no row under the id, should not be final', () => {
    expect(cacheHasConsistentFinalMessage([row('other', 'complete')], 'm1', false)).toBe(false);
  });

  it('given an empty cache, should not be final', () => {
    expect(cacheHasConsistentFinalMessage([], 'm1', false)).toBe(false);
  });
});
