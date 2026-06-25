/**
 * Pure shaping + validity for the per-user AI-processing consent record.
 *
 * GDPR Art 13(1)(e)(f) / 44: users must be told (and consent) that their prompts
 * leave the platform — sent to external AI providers, potentially outside the EU.
 * This module shapes the durable record; the DB table + capture route are thin edges.
 *
 * Client-safe: no Node.js dependencies.
 */

/** Bump when the AI-processing disclosure materially changes, to force re-consent. */
export const AI_CONSENT_POLICY_VERSION = 1;

export interface AiConsentRecord {
  userId: string;
  policyVersion: number;
  /** ISO timestamp the user consented. */
  consentedAt: string;
  /** ISO timestamp the user revoked, or null while active. */
  revokedAt: string | null;
}

/** Build a fresh, active AI-processing consent record. */
export function buildAiConsentRecord(
  userId: string,
  policyVersion: number,
  nowIso: string,
): AiConsentRecord {
  return {
    userId,
    policyVersion,
    consentedAt: nowIso,
    revokedAt: null,
  };
}

/**
 * Valid only when a record exists, is not revoked, and matches the current policy
 * version. A stale version means the disclosure changed and re-consent is required.
 */
export function hasValidAiConsent(
  record: AiConsentRecord | null | undefined,
  currentPolicyVersion: number,
): boolean {
  if (!record) return false;
  if (record.revokedAt !== null) return false;
  return record.policyVersion === currentPolicyVersion;
}
