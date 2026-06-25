import { describe, it, expect } from 'vitest';
import {
  AI_CONSENT_POLICY_VERSION,
  buildAiConsentRecord,
  hasValidAiConsent,
} from '../ai-consent';

const NOW = '2026-06-24T12:00:00.000Z';

describe('ai-consent: record shaping', () => {
  it('builds a record carrying userId, policy version, consentedAt, and null revokedAt', () => {
    const record = buildAiConsentRecord('user_123', AI_CONSENT_POLICY_VERSION, NOW);
    expect(record).toEqual({
      userId: 'user_123',
      policyVersion: AI_CONSENT_POLICY_VERSION,
      consentedAt: NOW,
      revokedAt: null,
    });
  });
});

describe('ai-consent: validity', () => {
  it('is valid when current version and not revoked', () => {
    const record = buildAiConsentRecord('user_123', AI_CONSENT_POLICY_VERSION, NOW);
    expect(hasValidAiConsent(record, AI_CONSENT_POLICY_VERSION)).toBe(true);
  });

  it('is invalid when revoked', () => {
    const record = { ...buildAiConsentRecord('user_123', AI_CONSENT_POLICY_VERSION, NOW), revokedAt: NOW };
    expect(hasValidAiConsent(record, AI_CONSENT_POLICY_VERSION)).toBe(false);
  });

  it('is invalid when the policy version is stale', () => {
    const record = buildAiConsentRecord('user_123', AI_CONSENT_POLICY_VERSION - 1, NOW);
    expect(hasValidAiConsent(record, AI_CONSENT_POLICY_VERSION)).toBe(false);
  });

  it('is invalid when there is no record', () => {
    expect(hasValidAiConsent(null, AI_CONSENT_POLICY_VERSION)).toBe(false);
  });
});
