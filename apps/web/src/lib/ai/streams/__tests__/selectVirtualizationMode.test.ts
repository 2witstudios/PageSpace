import { describe, it, expect } from 'vitest';
import { selectVirtualizationMode } from '../selectVirtualizationMode';

describe('selectVirtualizationMode', () => {
  it('given no stream in flight, should adopt the desired mode', () => {
    expect(selectVirtualizationMode({ desired: true, isStreaming: false, current: false })).toBe(true);
    expect(selectVirtualizationMode({ desired: false, isStreaming: false, current: true })).toBe(false);
  });

  it('given a stream in flight, should hold the current mode rather than cross', () => {
    // The streaming message is what pushes the count over the threshold, so this is
    // the case that would otherwise swap plain rows for virtualized ones mid-response.
    expect(selectVirtualizationMode({ desired: true, isStreaming: true, current: false })).toBe(false);
  });

  it('given a stream in flight and the mode already matching, should be a no-op', () => {
    expect(selectVirtualizationMode({ desired: true, isStreaming: true, current: true })).toBe(true);
    expect(selectVirtualizationMode({ desired: false, isStreaming: true, current: false })).toBe(false);
  });

  it('given the stream has settled, should apply the crossing that was deferred', () => {
    expect(selectVirtualizationMode({ desired: true, isStreaming: false, current: false })).toBe(true);
  });

  it('given a stream in flight, should also hold a de-virtualizing change', () => {
    // Messages can be deleted mid-stream; dropping back to plain rows discards the
    // virtualizer's heights just as the other direction does.
    expect(selectVirtualizationMode({ desired: false, isStreaming: true, current: true })).toBe(true);
  });
});
