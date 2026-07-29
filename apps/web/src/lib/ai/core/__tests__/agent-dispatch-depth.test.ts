import { describe, it, expect } from 'vitest';
import {
  parseAgentDispatchDepth,
  readAgentDispatchDepth,
  AGENT_DISPATCH_DEPTH_HEADER,
} from '../agent-dispatch-depth';

/**
 * This is the termination condition of a recursive system: a worker's turn runs
 * through the same chat route a human turn does, and this header is the only
 * thing carrying chain depth across that hop. Everything malformed must collapse
 * to 0 — the value a request with no dispatch history should carry.
 */
describe('parseAgentDispatchDepth', () => {
  it('given a positive integer, should use it', () => {
    expect(parseAgentDispatchDepth('3')).toBe(3);
  });

  it('given an absent header, should be 0', () => {
    expect(parseAgentDispatchDepth(null)).toBe(0);
    expect(parseAgentDispatchDepth(undefined)).toBe(0);
    expect(parseAgentDispatchDepth('')).toBe(0);
  });

  it('given zero or a negative depth, should be 0 rather than counting backwards', () => {
    expect(parseAgentDispatchDepth('0')).toBe(0);
    expect(parseAgentDispatchDepth('-5')).toBe(0);
  });

  it('given a non-numeric or fractional value, should be 0', () => {
    expect(parseAgentDispatchDepth('abc')).toBe(0);
    expect(parseAgentDispatchDepth('NaN')).toBe(0);
    // parseInt truncates, so a fraction is only ever accepted as its floor —
    // pinned so a future switch to Number() cannot silently admit 2.9 as 2.9.
    expect(parseAgentDispatchDepth('2.9')).toBe(2);
  });

  it('given a huge value, should pass it through — forging HIGH only restricts the forger', () => {
    // Deliberately not clamped at the top: the cap is enforced downstream, and a
    // client that inflates its own depth only reaches MAX_AGENT_DEPTH sooner.
    expect(parseAgentDispatchDepth('999')).toBe(999);
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
