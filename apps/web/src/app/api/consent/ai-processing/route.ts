/**
 * Per-user AI-processing consent (GDPR Art 13(1)(e)(f), Art 7(1), Art 44).
 *
 * Records that the user consents to their prompts leaving the platform — sent to
 * external AI providers, potentially outside the EU. Shaping/validity is the pure
 * @pagespace/lib/consent module; persistence is the thin service edge.
 *
 *   GET    → { consented, policyVersion }
 *   POST   → record consent at the current policy version
 *   DELETE → revoke consent
 */
import { NextResponse } from 'next/server';
import { AI_CONSENT_POLICY_VERSION } from '@pagespace/lib/consent';
import {
  getActiveAiConsent,
  hasActiveAiConsent,
  recordAiConsent,
  revokeAiConsent,
} from '@pagespace/lib/consent/ai-consent-service';
import { hasValidAiConsent } from '@pagespace/lib/consent';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const record = await getActiveAiConsent(auth.userId);
    return NextResponse.json({
      consented: hasValidAiConsent(record, AI_CONSENT_POLICY_VERSION),
      policyVersion: AI_CONSENT_POLICY_VERSION,
      consentedAt: record?.consentedAt ?? null,
    });
  } catch (error) {
    loggers.api.error('Error reading AI processing consent:', error as Error);
    return NextResponse.json({ error: 'Failed to read consent' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    // Idempotent: re-recording when already valid is a no-op write of a fresh row.
    if (!(await hasActiveAiConsent(auth.userId))) {
      await recordAiConsent(auth.userId);
    }
    return NextResponse.json({ consented: true, policyVersion: AI_CONSENT_POLICY_VERSION });
  } catch (error) {
    loggers.api.error('Error recording AI processing consent:', error as Error);
    return NextResponse.json({ error: 'Failed to record consent' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    await revokeAiConsent(auth.userId);
    return NextResponse.json({ consented: false });
  } catch (error) {
    loggers.api.error('Error revoking AI processing consent:', error as Error);
    return NextResponse.json({ error: 'Failed to revoke consent' }, { status: 500 });
  }
}
