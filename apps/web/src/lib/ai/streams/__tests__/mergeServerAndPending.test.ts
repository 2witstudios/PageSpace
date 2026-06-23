import { describe, it, expect } from 'vitest';
import { mergeServerAndPending } from '../mergeServerAndPending';
import type { UIMessage } from 'ai';

const makeMsg = (id: string, text: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
});

describe('mergeServerAndPending', () => {
  it('returns serverMessages unchanged when pendingMessageId is undefined (no in-flight stream)', () => {
    const server = [makeMsg('m1', 'hello'), makeMsg('m2', 'world')];
    const result = mergeServerAndPending(server, [], undefined);
    expect(result).toBe(server);
  });

  it('appends a synthesized message when the pending id is absent from the server list', () => {
    const server = [makeMsg('m1', 'hello')];
    const parts = [{ type: 'text' as const, text: 'streaming...' }];
    const result = mergeServerAndPending(server, parts, 'pending-1');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('m1');
    expect(result[1].id).toBe('pending-1');
    expect(result[1].role).toBe('assistant');
    expect(result[1].parts).toEqual(parts);
  });

  it('returns serverMessages unchanged (deduplicated) when the pending id is already in the server list', () => {
    const server = [makeMsg('m1', 'hello'), makeMsg('pending-1', 'finished response')];
    const parts = [{ type: 'text' as const, text: 'streaming...' }];
    const result = mergeServerAndPending(server, parts, 'pending-1');
    expect(result).toBe(server);
    expect(result).toHaveLength(2);
  });

  it('handles an empty server list with a pending stream — produces a single synthesized message', () => {
    const parts = [{ type: 'text' as const, text: 'first response' }];
    const result = mergeServerAndPending([], parts, 'pending-1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('pending-1');
  });

  it('does not mutate the serverMessages array when appending', () => {
    const server = [makeMsg('m1', 'hello')];
    const parts = [{ type: 'text' as const, text: 'streaming...' }];
    const result = mergeServerAndPending(server, parts, 'pending-1');
    expect(result).not.toBe(server);
    expect(server).toHaveLength(1);
  });
});
