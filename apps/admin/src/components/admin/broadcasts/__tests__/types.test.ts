import { describe, it, expect } from 'vitest';
import { isTerminalStatus } from '../types';

describe('isTerminalStatus', () => {
  it('treats completed, failed, and cancelled as terminal — polling stops here', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  it('treats every in-flight status as non-terminal', () => {
    expect(isTerminalStatus('draft')).toBe(false);
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('in_progress')).toBe(false);
    expect(isTerminalStatus('paused')).toBe(false);
  });
});
