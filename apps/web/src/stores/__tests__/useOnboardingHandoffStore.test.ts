import { describe, expect, test, beforeEach } from 'vitest';
import { useOnboardingHandoffStore } from '../useOnboardingHandoffStore';

beforeEach(() => {
  useOnboardingHandoffStore.setState({ pendingRequest: null });
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
