import { describe, it, expect } from 'vitest';
import { isTerminalStatus } from '../types';

describe('isTerminalStatus', () => {
  it('treats completed and cancelled as terminal — polling stops here', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  it('treats every in-flight status as non-terminal', () => {
    expect(isTerminalStatus('draft')).toBe(false);
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('queued')).toBe(false);
    expect(isTerminalStatus('in_progress')).toBe(false);
    expect(isTerminalStatus('paused')).toBe(false);
  });

  it('treats failed as NON-terminal — the worker rethrows on a retryable failure so pg-boss can resume the row, which can later reach in_progress or completed', () => {
    expect(isTerminalStatus('failed')).toBe(false);
  });
});
