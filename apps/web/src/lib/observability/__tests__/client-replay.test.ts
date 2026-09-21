import { describe, it, expect } from 'vitest';
import { clientReplaySampling } from '../client-replay';

describe('clientReplaySampling', () => {
  // The native app shows no consent prompt and App Review is told it does not
  // record or analyse usage (5.1.2(i), 2.5.14).
  it('given the native app, should record no session replays at all', () => {
    expect(clientReplaySampling({ isNative: true })).toEqual({
      enabled: false,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
    });
  });

  it('given the web, should keep the existing replay sampling', () => {
    expect(clientReplaySampling({ isNative: false })).toEqual({
      enabled: true,
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,
    });
  });
});
