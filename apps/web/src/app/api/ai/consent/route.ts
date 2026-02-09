import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { aiConsentRepository } from '@/lib/repositories/ai-consent-repository';
import { requiresConsent } from '@/lib/ai/core/ai-providers-config';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * GET /api/ai/consent
 * Returns user's consent records
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    const consents = await aiConsentRepository.getConsents(auth.userId);
    return NextResponse.json({ consents });
  } catch (error) {
    loggers.ai.error('Failed to get consent records', error as Error);
    return NextResponse.json({ error: 'Failed to retrieve consents' }, { status: 500 });
  }
}

/**
 * POST /api/ai/consent
 * Grant consent for a provider
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const { provider } = await request.json();
    if (!provider || typeof provider !== 'string') {
      return NextResponse.json({ error: 'provider is required' }, { status: 400 });
    }

    if (!requiresConsent(provider)) {
      return NextResponse.json(
        { error: 'This provider does not require consent' },
        { status: 400 }
      );
    }

    await aiConsentRepository.grantConsent(auth.userId, provider);
    loggers.ai.info('AI consent granted', { userId: auth.userId, provider });

    return NextResponse.json({ success: true, provider }, { status: 201 });
  } catch (error) {
    loggers.ai.error('Failed to grant consent', error as Error);
    return NextResponse.json({ error: 'Failed to grant consent' }, { status: 500 });
  }
}

/**
 * DELETE /api/ai/consent
 * Revoke consent for a provider
 */
export async function DELETE(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;

    const { provider } = await request.json();
    if (!provider || typeof provider !== 'string') {
      return NextResponse.json({ error: 'provider is required' }, { status: 400 });
    }

    await aiConsentRepository.revokeConsent(auth.userId, provider);
    loggers.ai.info('AI consent revoked', { userId: auth.userId, provider });

    return new Response(null, { status: 204 });
  } catch (error) {
    loggers.ai.error('Failed to revoke consent', error as Error);
    return NextResponse.json({ error: 'Failed to revoke consent' }, { status: 500 });
  }
}
