import { describe, it, expect } from 'vitest';
import { shouldSkipBootstrappedStream } from '../shouldSkipBootstrappedStream';

describe('shouldSkipBootstrappedStream', () => {
  it('given a messageId not seen anywhere, should not skip', () => {
    expect(shouldSkipBootstrappedStream('msg-1', new Set(), new Map())).toBe(false);
  });

  it('given a messageId already in the processed set (already finalized via socket race), should skip', () => {
    expect(shouldSkipBootstrappedStream('msg-1', new Set(['msg-1']), new Map())).toBe(true);
  });

  it('given a messageId already with an active controller (live consume in flight), should skip', () => {
    const controllers = new Map<string, unknown>([['msg-1', {}]]);
    expect(shouldSkipBootstrappedStream('msg-1', new Set(), controllers)).toBe(true);
  });

  it('given a messageId in both sets, should skip (no double-skip surprises)', () => {
    const controllers = new Map<string, unknown>([['msg-1', {}]]);
    expect(shouldSkipBootstrappedStream('msg-1', new Set(['msg-1']), controllers)).toBe(true);
  });

  it('given a different messageId from what is tracked, should not skip', () => {
    const controllers = new Map<string, unknown>([['msg-1', {}]]);
    expect(shouldSkipBootstrappedStream('msg-2', new Set(['msg-3']), controllers)).toBe(false);
  });
});
