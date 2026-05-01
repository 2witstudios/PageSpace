import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  ALL_PROVIDER_NAMES,
  buildProviderAvailabilityMap,
  getDefaultPageSpaceSettings,
  isProviderAvailable,
} from '@/lib/ai/core/ai-utils';
import { ONPREM_ALLOWED_PROVIDERS } from '@/lib/ai/core/ai-providers-config';
import { aiSettingsRepository } from '@/lib/repositories/ai-settings-repository';
import { requiresProSubscription } from '@/lib/subscription/rate-limit-middleware';
import { isOnPrem } from '@pagespace/lib/deployment-mode';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const GONE_RESPONSE = {
  error: 'Per-user API key configuration has been retired. AI providers are now managed at the deployment level.',
};

function availabilityOptions() {
  return { isOnPrem: isOnPrem(), onPremAllowed: ONPREM_ALLOWED_PROVIDERS };
}

/**
 * GET /api/ai/settings
 * Returns deployment-level provider availability and the user's selected provider/model.
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_settings', resourceId: 'get', details: { reason: 'auth_failed', method: 'GET' }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const user = await aiSettingsRepository.getUserSettings(userId);
    const pageSpaceSettings = getDefaultPageSpaceSettings();
    const providers = buildProviderAvailabilityMap(availabilityOptions());

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'ai_settings', resourceId: userId, details: {
      action: 'get_settings',
    } });

    return NextResponse.json({
      currentProvider: user?.currentAiProvider || 'pagespace',
      currentModel: user?.currentAiModel || 'glm-4.5-air',
      userSubscriptionTier: user?.subscriptionTier || 'free',
      pageSpaceBackend: pageSpaceSettings?.provider ?? null,
      providers,
      isAnyProviderConfigured: Object.values(providers).some((p) => p.isAvailable),
    });
  } catch (error) {
    loggers.ai.error('Failed to get AI settings', error as Error);
    return NextResponse.json(
      { error: 'Failed to retrieve settings' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/ai/settings — RETIRED
 * Per-user API keys are no longer accepted; deployment env vars are the single source.
 */
export async function POST() {
  return NextResponse.json(GONE_RESPONSE, { status: 410 });
}

/**
 * DELETE /api/ai/settings — RETIRED
 * Per-user API keys are no longer accepted.
 */
export async function DELETE() {
  return NextResponse.json(GONE_RESPONSE, { status: 410 });
}

/**
 * PATCH /api/ai/settings
 * Updates user's current provider/model selection. Rejects providers that are unavailable on this deployment.
 */
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_settings', resourceId: 'update_selection', details: { reason: 'auth_failed', method: 'PATCH' }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const body = await request.json();
    const { provider, model } = body;

    if (!provider || !(ALL_PROVIDER_NAMES as readonly string[]).includes(provider)) {
      return NextResponse.json(
        { error: `Invalid provider. Must be one of: ${ALL_PROVIDER_NAMES.join(', ')}` },
        { status: 400 }
      );
    }

    if (!isProviderAvailable(provider, availabilityOptions())) {
      return NextResponse.json(
        { error: `Provider "${provider}" is not configured on this deployment.` },
        { status: 503 }
      );
    }

    const isLocalProvider = ONPREM_ALLOWED_PROVIDERS.has(provider);
    if (!isLocalProvider && (!model || typeof model !== 'string')) {
      return NextResponse.json(
        { error: 'Model is required' },
        { status: 400 }
      );
    }

    const user = await aiSettingsRepository.getUserSettings(userId);
    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    if (requiresProSubscription(provider, model, user.subscriptionTier ?? undefined)) {
      return NextResponse.json(
        {
          error: 'Subscription required',
          message: 'PageSpace Pro AI requires a Pro or Business subscription.',
          upgradeUrl: '/settings/billing',
        },
        { status: 403 }
      );
    }

    try {
      await aiSettingsRepository.updateProviderSettings(userId, { provider, model });

      auditRequest(request, { eventType: 'data.write', userId, resourceType: 'ai_settings', resourceId: provider, details: {
        action: 'update_model_selection',
        provider,
        model,
      } });

      return NextResponse.json(
        {
          success: true,
          provider,
          model,
          message: 'Model selection updated successfully',
        },
        { status: 200 }
      );
    } catch (updateError) {
      loggers.ai.error('Failed to update model selection', updateError as Error, { provider, model });
      return NextResponse.json(
        { error: 'Failed to update model selection' },
        { status: 500 }
      );
    }
  } catch (error) {
    loggers.ai.error('Failed to update settings', error as Error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
