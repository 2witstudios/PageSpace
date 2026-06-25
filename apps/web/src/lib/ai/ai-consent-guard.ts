/**
 * Server-side enforcement of per-user AI-processing consent (GDPR Art 13(1)(e)(f), 44).
 *
 * Flag-gated and default-OFF so it can be rolled out without changing behavior for
 * existing users until the org is ready (same pattern as CREDITS_ENFORCEMENT_ENABLED /
 * CODE_EXECUTION_ENABLED). When enabled, user-facing AI entry routes consult
 * hasActiveAiConsent before sending any prompt to an external provider.
 */
import { hasActiveAiConsent } from '@pagespace/lib/consent/ai-consent-service';
import { AI_CONSENT_POLICY_VERSION } from '@pagespace/lib/consent';

/** Whether AI-processing consent is enforced (rollout flag; default off). */
export function isAiProcessingConsentEnforced(): boolean {
  return process.env.AI_PROCESSING_CONSENT_ENFORCED === 'true';
}

/**
 * Returns a 403 Response when enforcement is on AND the user has not granted valid
 * AI-processing consent; otherwise null (proceed). Callers return the Response as-is.
 */
export async function assertAiProcessingConsent(userId: string): Promise<Response | null> {
  if (!isAiProcessingConsentEnforced()) return null;
  if (await hasActiveAiConsent(userId)) return null;
  return Response.json(
    {
      error: 'AI processing consent required',
      code: 'ai_consent_required',
      policyVersion: AI_CONSENT_POLICY_VERSION,
    },
    { status: 403 },
  );
}
