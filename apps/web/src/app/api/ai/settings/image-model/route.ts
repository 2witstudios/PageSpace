import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { aiSettingsRepository } from '@/lib/repositories/ai-settings-repository';
import { fetchOpenRouterImageModels } from '@/lib/ai/core/model-capabilities';
import { isImageGenerationAllowed, isValidImageModel } from '@/lib/ai/core/image-gen-access';
import { isOnPrem } from '@pagespace/lib/deployment-mode';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * PATCH /api/ai/settings/image-model
 * Sets (or clears with null) the user's chosen OpenRouter image-generation model.
 * Pro+ gated; validated against the live image-capable model list.
 */
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      auditRequest(request, {
        eventType: 'authz.access.denied',
        resourceType: 'ai_settings',
        resourceId: 'image_model',
        details: { reason: 'auth_failed', method: 'PATCH' },
        riskScore: 0.5,
      });
      return auth.error;
    }
    const userId = auth.userId;

    if (isOnPrem()) {
      return NextResponse.json({ error: 'Image generation is not available in on-premise mode.' }, { status: 503 });
    }

    const body = await request.json().catch(() => ({}));
    const model: unknown = body?.imageGenerationModel;
    if (model !== null && typeof model !== 'string') {
      return NextResponse.json({ error: 'imageGenerationModel must be a string or null.' }, { status: 400 });
    }

    const user = await aiSettingsRepository.getUserSettings(userId);
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Rollout gate: image generation is currently restricted to app admins.
    if (!isImageGenerationAllowed(auth.role === 'admin')) {
      return NextResponse.json(
        {
          error: 'Not available',
          message: 'Image generation is currently restricted to app administrators.',
        },
        { status: 403 },
      );
    }

    // Validate a non-null selection against the live image-model list.
    if (model !== null) {
      const available = await fetchOpenRouterImageModels();
      if (!isValidImageModel(model, available)) {
        return NextResponse.json(
          { error: `"${model}" is not a valid image-generation model.` },
          { status: 400 },
        );
      }
    }

    await aiSettingsRepository.updateImageGenerationModel(userId, model);

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'ai_settings',
      resourceId: 'image_model',
      details: { action: 'update_image_model', model },
    });

    return NextResponse.json({ success: true, imageGenerationModel: model }, { status: 200 });
  } catch (error) {
    loggers.ai.error('Failed to update image-generation model', error as Error);
    return NextResponse.json({ error: 'Failed to update image-generation model' }, { status: 500 });
  }
}
