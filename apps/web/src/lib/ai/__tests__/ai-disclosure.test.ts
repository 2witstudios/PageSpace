import { describe, it, expect, beforeEach } from 'vitest';
import { needsAiDisclosure, hasAcknowledgedAiDisclosure, acknowledgeAiDisclosure, AI_DISCLOSURE_STORAGE_KEY } from '../ai-disclosure';

describe('AI data-sharing disclosure', () => {
  beforeEach(() => {
    window.localStorage.removeItem(AI_DISCLOSURE_STORAGE_KEY);
  });

  // Guideline 5.1.2(i): disclose sharing with third-party AI and get permission first.
  it('given the native app and no acknowledgement yet, should require the disclosure', () => {
    expect(needsAiDisclosure({ isNative: true, acknowledged: false })).toBe(true);
  });

  it('given the native app after the user agreed, should not ask again', () => {
    expect(needsAiDisclosure({ isNative: true, acknowledged: true })).toBe(false);
  });

  it('given the web, should not interrupt sending', () => {
    expect(needsAiDisclosure({ isNative: false, acknowledged: false })).toBe(false);
  });

  it('given the user agrees, should remember it on this device', () => {
    expect(hasAcknowledgedAiDisclosure()).toBe(false);
    acknowledgeAiDisclosure();
    expect(hasAcknowledgedAiDisclosure()).toBe(true);
  });

  it('given storage is unavailable, should treat the disclosure as not acknowledged instead of throwing', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
    try {
      expect(hasAcknowledgedAiDisclosure()).toBe(false);
      expect(() => acknowledgeAiDisclosure()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});
