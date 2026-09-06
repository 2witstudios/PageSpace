import { describe, expect, test, beforeEach } from 'vitest';
import { useOnboardingHandoffStore } from '../useOnboardingHandoffStore';

const STORAGE_KEY = 'pagespace:onboarding:pendingRequest';

beforeEach(() => {
  useOnboardingHandoffStore.setState({ pendingRequest: null });
  window.sessionStorage.clear();
});

describe('useOnboardingHandoffStore', () => {
  test('carries the request from onboarding to the assistant', () => {
    useOnboardingHandoffStore.getState().setPendingRequest('Help me run my landscaping business');
    expect(useOnboardingHandoffStore.getState().claim()).toBe('Help me run my landscaping business');
  });

  test('claim is take-once, so a remount never re-sends the first request', () => {
    useOnboardingHandoffStore.getState().setPendingRequest('run my bakery');
    expect(useOnboardingHandoffStore.getState().claim()).toBe('run my bakery');
    // The concrete bug this prevents: the assistant remounts, claims again, and
    // the user's first request is sent — and billed — twice.
    expect(useOnboardingHandoffStore.getState().claim()).toBeNull();
  });

  test('claiming when nothing is pending returns null rather than an empty send', () => {
    expect(useOnboardingHandoffStore.getState().claim()).toBeNull();
  });

  test('ignores a blank request rather than queueing an empty send', () => {
    useOnboardingHandoffStore.getState().setPendingRequest('   ');
    expect(useOnboardingHandoffStore.getState().pendingRequest).toBeNull();
  });

  test('trims what it stores', () => {
    useOnboardingHandoffStore.getState().setPendingRequest('  spaced  ');
    expect(useOnboardingHandoffStore.getState().claim()).toBe('spaced');
  });

  test('clear drops a queued request without sending it', () => {
    useOnboardingHandoffStore.getState().setPendingRequest('never mind');
    useOnboardingHandoffStore.getState().clear();
    expect(useOnboardingHandoffStore.getState().claim()).toBeNull();
  });
});

describe('surviving a reload', () => {
  test('a queued request outlives the page, so a refresh does not lose it', () => {
    // Onboarding can complete on a route where the assistant is not mounted
    // (an invited user landing on a page). Completion has already been recorded
    // server-side, so an in-memory-only queue would strand the request with no
    // way to retry.
    useOnboardingHandoffStore.getState().setPendingRequest('run my bakery');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('run my bakery');

    // Simulate a reload: fresh in-memory state, storage intact.
    useOnboardingHandoffStore.setState({ pendingRequest: null });
    useOnboardingHandoffStore.getState().hydrate();
    expect(useOnboardingHandoffStore.getState().pendingRequest).toBe('run my bakery');
  });

  test('claiming clears the stored copy too, so a reload cannot resurrect it', () => {
    useOnboardingHandoffStore.getState().setPendingRequest('run my bakery');
    useOnboardingHandoffStore.getState().claim();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();

    useOnboardingHandoffStore.setState({ pendingRequest: null });
    useOnboardingHandoffStore.getState().hydrate();
    expect(useOnboardingHandoffStore.getState().pendingRequest).toBeNull();
  });

  test('hydrate never overwrites a request already in memory', () => {
    window.sessionStorage.setItem(STORAGE_KEY, 'stale');
    useOnboardingHandoffStore.setState({ pendingRequest: 'current' });
    useOnboardingHandoffStore.getState().hydrate();
    expect(useOnboardingHandoffStore.getState().pendingRequest).toBe('current');
  });
});

describe('restoring after a failed send', () => {
  test('a request put back after failure can be claimed again', () => {
    useOnboardingHandoffStore.getState().setPendingRequest('run my bakery');
    const claimed = useOnboardingHandoffStore.getState().claim();
    expect(claimed).toBe('run my bakery');

    // The send was refused before admission (e.g. a 402). The user was told it
    // was sent, so losing it here would be silent data loss.
    useOnboardingHandoffStore.getState().restore(claimed!);
    expect(useOnboardingHandoffStore.getState().pendingRequest).toBe('run my bakery');
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('run my bakery');
  });
});
