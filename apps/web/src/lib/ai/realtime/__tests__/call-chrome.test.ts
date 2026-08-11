import { describe, expect, it } from 'vitest';
import { describeCall, isCallLive, type CallChromeFacts } from '../call-chrome';
import { micFailureMessage } from '@/lib/voice/mic-errors';

const facts = (overrides: Partial<CallChromeFacts> = {}): CallChromeFacts => ({
  status: 'idle',
  error: undefined,
  failure: undefined,
  attached: false,
  bound: false,
  ...overrides,
});

describe('describeCall — the two states a "voice failed" would flatten', () => {
  it('should offer a retry for a REFUSED microphone', () => {
    const chrome = describeCall(
      facts({
        status: 'error',
        failure: 'mic-denied',
        error: micFailureMessage('denied', false),
      }),
    );

    expect(chrome.state).toBe('error');
    expect(chrome.canRetry).toBe(true);
  });

  it('should NOT offer a retry when the microphone is ABSENT or unsupported', () => {
    // Retrying cannot conjure hardware. A button that is guaranteed to fail
    // teaches the user that voice is broken rather than that they have no
    // capture device.
    expect(
      describeCall(facts({ status: 'error', failure: 'mic-missing', error: 'x' })).canRetry,
    ).toBe(false);
    expect(
      describeCall(facts({ status: 'error', failure: 'mic-unsupported', error: 'x' })).canRetry,
    ).toBe(false);

    // A busy device IS retryable — the user closes the other app and tries again.
    expect(
      describeCall(facts({ status: 'error', failure: 'mic-busy', error: 'x' })).canRetry,
    ).toBe(true);
  });

  it('should carry the connector\'s own sentence through, never a generic one', () => {
    // The advice differs per failure and the advice is the entire point:
    // "allow it in settings" vs "connect a microphone".
    const denied = micFailureMessage('denied', false);
    const missing = micFailureMessage('missing', false);
    expect(denied).not.toBe(missing);

    expect(describeCall(facts({ status: 'error', failure: 'mic-denied', error: denied })).detail).toBe(
      denied,
    );
    expect(
      describeCall(facts({ status: 'error', failure: 'mic-missing', error: missing })).detail,
    ).toBe(missing);
  });

  it('should still say something when a failure arrived with no sentence', () => {
    const chrome = describeCall(facts({ status: 'error' }));
    expect(chrome.detail).toBeTruthy();
    // Unclassified: assume retryable rather than lock the user out of trying.
    expect(chrome.canRetry).toBe(true);
  });
});

describe('describeCall — attached is not a detail', () => {
  it('should distinguish a fully-capable call from one with no transcript', () => {
    const full = describeCall(facts({ status: 'connected', attached: true, bound: true }));
    const degraded = describeCall(facts({ status: 'connected', attached: false, bound: true }));

    expect(full.state).toBe('live');
    expect(full.detail).toBeNull();

    // A working audio call whose words will not reach the thread. The user has
    // to be TOLD, because it looks exactly like the working one.
    expect(degraded.state).toBe('degraded');
    expect(degraded.detail).toBeTruthy();
    expect(degraded.detail).toMatch(/saved|transcript/i);
  });

  it('should treat both as live — the colour says what is degraded, not whether the mic is open', () => {
    expect(isCallLive('live')).toBe(true);
    expect(isCallLive('degraded')).toBe(true);
    expect(isCallLive('connecting')).toBe(true);
    expect(isCallLive('idle')).toBe(false);
    expect(isCallLive('error')).toBe(false);
  });
});

describe('describeCall — idle', () => {
  it('should invite rather than report', () => {
    expect(describeCall(facts()).state).toBe('idle');
    expect(describeCall(facts()).label).toMatch(/start/i);
  });

  it('should never offer a retry for a state that has not failed', () => {
    for (const status of ['idle', 'connecting', 'connected'] as const) {
      expect(describeCall(facts({ status })).canRetry).toBe(false);
    }
  });
});
