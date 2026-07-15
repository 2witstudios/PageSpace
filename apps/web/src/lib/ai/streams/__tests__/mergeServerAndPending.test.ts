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

  it('stamps the synthesized message with a createdAt derived from pendingStartedAt', () => {
    const server = [makeMsg('m1', 'hello')];
    const parts = [{ type: 'text' as const, text: 'streaming...' }];
    const result = mergeServerAndPending(server, parts, 'pending-1', '2024-01-01T00:00:00.000Z');
    const synthesized = result[1] as UIMessage & { createdAt?: Date };
    expect(synthesized.createdAt).toEqual(new Date('2024-01-01T00:00:00.000Z'));
  });

  it('omits createdAt when pendingStartedAt is absent', () => {
    const server = [makeMsg('m1', 'hello')];
    const parts = [{ type: 'text' as const, text: 'streaming...' }];
    const result = mergeServerAndPending(server, parts, 'pending-1');
    expect('createdAt' in result[1]).toBe(false);
  });

  it('does not mutate the serverMessages array when appending', () => {
    const server = [makeMsg('m1', 'hello')];
    const parts = [{ type: 'text' as const, text: 'streaming...' }];
    const result = mergeServerAndPending(server, parts, 'pending-1');
    expect(result).not.toBe(server);
    expect(server).toHaveLength(1);
  });

  // Server Stream Durability epic PR 2: once a client opts into includeStreaming=1, a
  // server-loaded 'streaming' row for the SAME id as the live pending stream is an empty
  // placeholder — strictly staler than the pending stream's own buffered parts. The live
  // version must win, swapped in at the same position (not appended as a duplicate).
  it('replaces a server-loaded streaming placeholder with the live pending message at the same position', () => {
    const placeholder = { ...makeMsg('pending-1', ''), status: 'streaming' as const };
    const server = [makeMsg('m1', 'hello'), placeholder, makeMsg('m2', 'world')];
    const parts = [{ type: 'text' as const, text: 'streaming so far...' }];
    const result = mergeServerAndPending(server, parts, 'pending-1');
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('m1');
    expect(result[1].id).toBe('pending-1');
    expect(result[1].parts).toEqual(parts);
    expect(result[2].id).toBe('m2');
  });

  it('keeps the server-loaded row when its status is complete, even if IDs match (existing dedup behavior)', () => {
    const finished = { ...makeMsg('pending-1', 'finished response'), status: 'complete' as const };
    const server = [makeMsg('m1', 'hello'), finished];
    const parts = [{ type: 'text' as const, text: 'streaming...' }];
    const result = mergeServerAndPending(server, parts, 'pending-1');
    expect(result).toBe(server);
  });

  it('keeps the server-loaded row when status is absent (legacy/pre-PR2 shape)', () => {
    const server = [makeMsg('m1', 'hello'), makeMsg('pending-1', 'finished response')];
    const parts = [{ type: 'text' as const, text: 'streaming...' }];
    const result = mergeServerAndPending(server, parts, 'pending-1');
    expect(result).toBe(server);
  });
});
