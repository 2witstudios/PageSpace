/**
 * AI PROVIDER SETTINGS — the read and write behind `GET`/`PATCH /api/ai/chat`.
 *
 * Nothing to do with a chat TURN. They share the URL for historical reasons and
 * the wire contract is frozen, so `route.ts` still exports them — but a file
 * whose POST is three lines of delegation and whose other 250 are settings CRUD
 * reads as one thing and is two. The route is now the URL binding; this is the
 * behaviour.
 */

import { NextResponse } from 'next/server';
import { ONPREM_ALLOWED_PROVIDERS, DEFAULT_PROVIDER, DEFAULT_MODEL } from '@/lib/ai/core/ai-providers-config';
import { resolveGenerationAdmission } from '@/lib/ai/core/generation-admission';
import { ALL_PROVIDER_NAMES } from '@/lib/ai/core/ai-utils';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { requiresProSubscription } from '@/lib/subscription/rate-limit-middleware';
import { authenticateRequestWithOptions, isAuthError, canPrincipalEditPage } from '@/lib/auth';
import { getActorInfo } from '@pagespace/lib/monitoring/activity-logger';
import { buildProviderAvailabilityMap } from '@/lib/ai/core/ai-utils';

import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { pages } from '@pagespace/db/schema/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { applyPageMutation, PageRevisionMismatchError } from '@/services/api/page-mutation-service';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * GET handler to check multi-provider configuration status and current settings
 */
export async function getAiChatSettings(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_chat_settings', resourceId: 'get', details: { reason: 'auth_failed', method: 'GET', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    // Get pageId from query params
    const url = new URL(request.url);
    const pageId = url.searchParams.get('pageId');
    
    // Get user's current provider settings
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    
    // Get page-specific settings if pageId provided
    let currentProvider = user?.currentAiProvider || DEFAULT_PROVIDER;
    let currentModel = user?.currentAiModel || DEFAULT_MODEL;
    
    if (pageId) {
      const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
      if (page) {
        // Use page-specific settings if they exist, otherwise fallback to user settings
        currentProvider = page.aiProvider || currentProvider;
        currentModel = page.aiModel || currentModel;
      }
    }
    
    const providers = buildProviderAvailabilityMap({
      isOnPrem: isOnPrem(),
      onPremAllowed: ONPREM_ALLOWED_PROVIDERS,
    });

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'ai_chat_settings', resourceId: pageId || userId, details: {
      action: 'get_provider_settings',
    } });

    return NextResponse.json({
      currentProvider,
      currentModel,
      providers,
      isAnyProviderConfigured: Object.values(providers).some((p) => p.isAvailable),
    });

  } catch (error) {
    loggers.ai.error('Error checking provider settings', error as Error);
    return NextResponse.json({ 
      error: 'Failed to check settings' 
    }, { status: 500 });
  }
}

/**
 * Validate provider and model combination
 * Ensures the provider/model pair is supported and user has access
 */
async function validateProviderModel(
  provider: string,
  model: string,
  userId: string
): Promise<{ valid: boolean; reason?: string }> {
  // Check if provider is valid
  if (!(ALL_PROVIDER_NAMES as readonly string[]).includes(provider)) {
    return {
      valid: false,
      reason: `Invalid provider: ${provider}. Supported providers: ${ALL_PROVIDER_NAMES.join(', ')}`
    };
  }

  // Validate model string format (basic sanity check)
  if (!model || typeof model !== 'string' || model.length > 100) {
    return {
      valid: false,
      reason: 'Invalid model format'
    };
  }

  // Check subscription requirements for paid models
  try {
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const isAdminUser = user?.role === 'admin';
    const admission = resolveGenerationAdmission({
      provider,
      model,
      subscriptionTier: user?.subscriptionTier ?? undefined,
      isAdmin: isAdminUser,
      requiresProSubscription,
    });
    if (!admission.allowed) {
      return {
        valid: false,
        reason:
          admission.reason === 'provider_admin_only'
            ? 'This provider is restricted to administrators.'
            : 'A paid plan is required for this model',
      };
    }
  } catch (error) {
    loggers.ai.error('Error checking subscription requirements', error as Error);
    return {
      valid: false,
      reason: 'Unable to validate subscription requirements'
    };
  }

  // Additional provider-specific validation could go here
  // For now, basic validation is sufficient

  return { valid: true };
}

/**
 * PATCH handler to update page-specific AI settings
 */
export async function patchAiChatSettings(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'ai_chat_settings', resourceId: 'update', details: { reason: 'auth_failed', method: 'PATCH', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }

    const body = await request.json();

    // Enhanced input validation with type checking
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const { pageId, provider, model, expectedRevision } = body;

    // Validate pageId (should be a CUID)
    if (!pageId || typeof pageId !== 'string' || pageId.length < 10 || pageId.length > 30) {
      return NextResponse.json(
        { error: 'Invalid pageId format' },
        { status: 400 }
      );
    }

    // Validate provider
    if (!provider || typeof provider !== 'string' || provider.length > 50) {
      return NextResponse.json(
        { error: 'Provider is required and must be a valid string' },
        { status: 400 }
      );
    }

    // Validate model
    if (!model || typeof model !== 'string' || model.length > 100) {
      return NextResponse.json(
        { error: 'Model is required and must be a valid string' },
        { status: 400 }
      );
    }

    // Sanitize inputs (trim whitespace and basic cleanup)
    const sanitizedProvider = provider.trim();
    const sanitizedModel = model.trim();
    const sanitizedPageId = pageId.trim();

    // Verify the user has access to this page
    const [page] = await db.select().from(pages).where(eq(pages.id, sanitizedPageId));
    if (!page) {
      return NextResponse.json(
        { error: 'Page not found' },
        { status: 404 }
      );
    }

    // Check if user has permission to edit this page (SECURITY: Critical permission enforcement)
    const canEdit = await canPrincipalEditPage(auth, sanitizedPageId);
    if (!canEdit) {
      loggers.ai.warn('AI Settings PATCH: User lacks edit permission', {
        userId: auth.userId,
        pageId: sanitizedPageId
      });
      auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'ai_chat_settings', resourceId: sanitizedPageId, details: { reason: 'no_edit_permission', method: 'PATCH' }, riskScore: 0.5 });
      return NextResponse.json(
        { error: 'You do not have permission to modify this page' },
        { status: 403 }
      );
    }

    // Validate provider and model combination (SECURITY: Validate permitted combinations)
    const validation = await validateProviderModel(sanitizedProvider, sanitizedModel, auth.userId);
    if (!validation.valid) {
      loggers.ai.warn('AI Settings PATCH: Invalid provider/model combination', {
        userId: auth.userId,
        pageId: sanitizedPageId,
        provider: sanitizedProvider,
        model: sanitizedModel,
        reason: validation.reason
      });
      return NextResponse.json(
        { error: validation.reason || 'Invalid provider/model combination' },
        { status: 400 }
      );
    }

    // Update page settings
    try {
      const actorInfo = await getActorInfo(auth.userId);
      await applyPageMutation({
        pageId: sanitizedPageId,
        operation: 'agent_config_update',
        updates: {
          aiProvider: sanitizedProvider,
          aiModel: sanitizedModel,
        },
        updatedFields: ['aiProvider', 'aiModel'],
        expectedRevision: typeof expectedRevision === 'number' ? expectedRevision : undefined,
        context: {
          userId: auth.userId,
          actorEmail: actorInfo.actorEmail,
          actorDisplayName: actorInfo.actorDisplayName,
          resourceType: 'agent',
        },
      });
    } catch (error) {
      if (error instanceof PageRevisionMismatchError) {
        return NextResponse.json(
          {
            error: error.message,
            currentRevision: error.currentRevision,
            expectedRevision: error.expectedRevision,
          },
          { status: error.expectedRevision === undefined ? 428 : 409 }
        );
      }
      throw error;
    }

    loggers.ai.info('AI Settings PATCH: Page settings updated successfully', {
      userId: auth.userId,
      pageId: sanitizedPageId,
      provider: sanitizedProvider,
      model: sanitizedModel
    });

    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'ai_chat_settings', resourceId: sanitizedPageId, details: {
      action: 'update_page_settings',
      provider: sanitizedProvider,
      model: sanitizedModel,
    } });

    return NextResponse.json({
      success: true,
      message: 'Page AI settings updated successfully',
      provider: sanitizedProvider,
      model: sanitizedModel,
    });
  } catch (error) {
    loggers.ai.error('Failed to update page AI settings', error as Error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
