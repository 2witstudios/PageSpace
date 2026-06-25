import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@pagespace/lib/consent/ai-consent-service', () => ({
  hasActiveAiConsent: vi.fn(),
}));

import { isAiProcessingConsentEnforced, assertAiProcessingConsent } from '../ai-consent-guard';
import { hasActiveAiConsent } from '@pagespace/lib/consent/ai-consent-service';

const ORIGINAL = process.env.AI_PROCESSING_CONSENT_ENFORCED;

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AI_PROCESSING_CONSENT_ENFORCED;
  else process.env.AI_PROCESSING_CONSENT_ENFORCED = ORIGINAL;
});

describe('isAiProcessingConsentEnforced', () => {
  it('is off unless the flag is exactly "true"', () => {
    delete process.env.AI_PROCESSING_CONSENT_ENFORCED;
    expect(isAiProcessingConsentEnforced()).toBe(false);
    process.env.AI_PROCESSING_CONSENT_ENFORCED = 'false';
    expect(isAiProcessingConsentEnforced()).toBe(false);
    process.env.AI_PROCESSING_CONSENT_ENFORCED = '1';
    expect(isAiProcessingConsentEnforced()).toBe(false);
    process.env.AI_PROCESSING_CONSENT_ENFORCED = 'true';
    expect(isAiProcessingConsentEnforced()).toBe(true);
  });
});

describe('assertAiProcessingConsent', () => {
  it('returns null (proceed) when enforcement is off — never reads consent', async () => {
    delete process.env.AI_PROCESSING_CONSENT_ENFORCED;
    const result = await assertAiProcessingConsent('user_1');
    expect(result).toBeNull();
    expect(hasActiveAiConsent).not.toHaveBeenCalled();
  });

  it('returns null when enforced and the user has consent', async () => {
    process.env.AI_PROCESSING_CONSENT_ENFORCED = 'true';
    vi.mocked(hasActiveAiConsent).mockResolvedValue(true);
    expect(await assertAiProcessingConsent('user_1')).toBeNull();
  });

  it('returns a 403 ai_consent_required when enforced and the user lacks consent', async () => {
    process.env.AI_PROCESSING_CONSENT_ENFORCED = 'true';
    vi.mocked(hasActiveAiConsent).mockResolvedValue(false);
    const result = await assertAiProcessingConsent('user_1');
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect((await result!.json()).code).toBe('ai_consent_required');
  });
});
