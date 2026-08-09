import { describe, it, expect } from 'vitest';
import { readAgentDispatchDepth, AGENT_DISPATCH_DEPTH_HEADER } from '../agent-dispatch-depth';

/** Drive the parse through the real entry point rather than an export that exists only for tests. */
function depthFromHeader(value?: string): number {
  const headers = new Headers();
  if (value !== undefined) headers.set(AGENT_DISPATCH_DEPTH_HEADER, value);
  return readAgentDispatchDepth(headers);
}

/**
 * This is the termination condition of a recursive system: a worker's turn runs
 * through the same chat route a human turn does, and this header is the only
 * thing carrying chain depth across that hop. Everything malformed must collapse
 * to 0 — the value a request with no dispatch history should carry.
 */
describe('dispatch depth parsing', () => {
  it('given a positive integer, should use it', () => {
    expect(depthFromHeader('3')).toBe(3);
  });

  it('given an absent header, should be 0', () => {
    expect(depthFromHeader()).toBe(0);
    expect(depthFromHeader()).toBe(0);
    expect(depthFromHeader('')).toBe(0);
  });

  it('given zero or a negative depth, should be 0 rather than counting backwards', () => {
    expect(depthFromHeader('0')).toBe(0);
    expect(depthFromHeader('-5')).toBe(0);
  });

  it('given a non-numeric or fractional value, should be 0', () => {
    expect(depthFromHeader('abc')).toBe(0);
    expect(depthFromHeader('NaN')).toBe(0);
    // parseInt truncates, so a fraction is only ever accepted as its floor —
    // pinned so a future switch to Number() cannot silently admit 2.9 as 2.9.
    expect(depthFromHeader('2.9')).toBe(2);
  });

  it('given a huge value, should pass it through — forging HIGH only restricts the forger', () => {
    // Deliberately not clamped at the top: the cap is enforced downstream, and a
    // client that inflates its own depth only reaches MAX_AGENT_DEPTH sooner.
    expect(depthFromHeader('999')).toBe(999);
  });
});

describe('readAgentDispatchDepth', () => {
  it('should read the canonical header name', () => {
    const headers = new Headers({ [AGENT_DISPATCH_DEPTH_HEADER]: '2' });
    expect(readAgentDispatchDepth(headers)).toBe(2);
  });

  it('given no such header, should be 0', () => {
    expect(readAgentDispatchDepth(new Headers())).toBe(0);
  });
});
