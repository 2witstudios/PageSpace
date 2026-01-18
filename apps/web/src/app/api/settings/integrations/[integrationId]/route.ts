/**
 * API Routes for Individual Integration Management
 *
 * GET    /api/settings/integrations/[integrationId] - Get integration details
 * PATCH  /api/settings/integrations/[integrationId] - Update integration
 * DELETE /api/settings/integrations/[integrationId] - Remove integration
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers, encrypt, decrypt } from '@pagespace/lib/server';
import { db, userIntegrations, eq, and } from '@pagespace/db';
import {
  getIntegration,
  isValidIntegrationId,
  updateIntegrationSchema,
} from '@/lib/integrations';

const integrationsLogger = loggers.api.child({ module: 'integrations' });

const AUTH_OPTIONS_READ = { allow: ['jwt'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt'] as const, requireCSRF: true };

type RouteParams = { params: Promise<{ integrationId: string }> };

/**
 * GET /api/settings/integrations/[integrationId]
 * Get details for a specific integration
 */
export async function GET(
  request: Request,
  context: RouteParams
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { integrationId } = await context.params;

    // Validate integration ID
    if (!isValidIntegrationId(integrationId)) {
      return NextResponse.json(
        { error: `Unknown integration: ${integrationId}` },
        { status: 404 }
      );
    }

    const definition = getIntegration(integrationId)!;

    // Get user's configuration
    const [userConfig] = await db
      .select()
      .from(userIntegrations)
      .where(
        and(
          eq(userIntegrations.userId, userId),
          eq(userIntegrations.integrationId, integrationId)
        )
      );

    return NextResponse.json({
      definition: {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        tagline: definition.tagline,
        icon: definition.icon,
        category: definition.category,
        docsUrl: definition.docsUrl,
        requiresApiKey: definition.requiresApiKey,
        apiKeyLabel: definition.apiKeyLabel,
        apiKeyDescription: definition.apiKeyDescription,
        configFields: definition.configFields,
        tools: definition.tools,
      },
      userConfig: userConfig ? {
        id: userConfig.id,
        enabled: userConfig.enabled,
        hasApiKey: !!userConfig.encryptedApiKey,
        config: userConfig.config,
        enabledTools: userConfig.enabledTools,
        validationStatus: userConfig.validationStatus,
        validationMessage: userConfig.validationMessage,
        lastValidatedAt: userConfig.lastValidatedAt,
        createdAt: userConfig.createdAt,
        updatedAt: userConfig.updatedAt,
      } : null,
      isConfigured: !!userConfig,
      isEnabled: userConfig?.enabled ?? false,
    });
  } catch (error) {
    integrationsLogger.error('Failed to get integration', error as Error);
    return NextResponse.json(
      { error: 'Failed to retrieve integration' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/settings/integrations/[integrationId]
 * Update an existing integration
 */
export async function PATCH(
  request: Request,
  context: RouteParams
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { integrationId } = await context.params;

    // Validate integration ID
    if (!isValidIntegrationId(integrationId)) {
      return NextResponse.json(
        { error: `Unknown integration: ${integrationId}` },
        { status: 404 }
      );
    }

    const definition = getIntegration(integrationId)!;
    const body = await request.json();

    // Validate input
    const parseResult = updateIntegrationSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const { enabled, apiKey, config, enabledTools } = parseResult.data;

    // Get existing configuration
    const [existing] = await db
      .select()
      .from(userIntegrations)
      .where(
        and(
          eq(userIntegrations.userId, userId),
          eq(userIntegrations.integrationId, integrationId)
        )
      );

    if (!existing) {
      return NextResponse.json(
        { error: 'Integration not configured. Use POST to configure.' },
        { status: 404 }
      );
    }

    // Build update object
    const updates: Record<string, unknown> = {};

    if (enabled !== undefined) {
      updates.enabled = enabled;
    }

    if (config !== undefined) {
      updates.config = { ...(existing.config as Record<string, unknown> || {}), ...config };
    }

    if (enabledTools !== undefined) {
      updates.enabledTools = enabledTools;
    }

    // Handle API key update
    if (apiKey !== undefined) {
      if (apiKey === '') {
        // Clear API key
        updates.encryptedApiKey = null;
        updates.validationStatus = 'unknown';
        updates.validationMessage = null;
        updates.lastValidatedAt = null;
      } else {
        // Encrypt and validate new API key
        updates.encryptedApiKey = await encrypt(apiKey.trim());

        try {
          const mergedConfig = { ...(existing.config as Record<string, unknown> || {}), ...config };
          const validationResult = await definition.validate(mergedConfig, apiKey);
          updates.validationStatus = validationResult.valid ? 'valid' : 'invalid';
          updates.validationMessage = validationResult.message;
          updates.lastValidatedAt = new Date();
        } catch (error) {
          updates.validationStatus = 'invalid';
          updates.validationMessage = error instanceof Error ? error.message : 'Validation failed';
          updates.lastValidatedAt = new Date();
        }
      }
    }

    // Apply updates
    const [updated] = await db
      .update(userIntegrations)
      .set(updates)
      .where(eq(userIntegrations.id, existing.id))
      .returning();

    integrationsLogger.info('Integration updated', {
      userId,
      integrationId,
      fieldsUpdated: Object.keys(updates),
    });

    return NextResponse.json({
      success: true,
      integration: {
        id: updated.id,
        integrationId: updated.integrationId,
        enabled: updated.enabled,
        hasApiKey: !!updated.encryptedApiKey,
        config: updated.config,
        enabledTools: updated.enabledTools,
        validationStatus: updated.validationStatus,
        validationMessage: updated.validationMessage,
      },
      message: `${definition.name} updated successfully`,
    });
  } catch (error) {
    integrationsLogger.error('Failed to update integration', error as Error);
    return NextResponse.json(
      { error: 'Failed to update integration' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/settings/integrations/[integrationId]
 * Remove an integration
 */
export async function DELETE(
  request: Request,
  context: RouteParams
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { integrationId } = await context.params;

    // Validate integration ID
    if (!isValidIntegrationId(integrationId)) {
      return NextResponse.json(
        { error: `Unknown integration: ${integrationId}` },
        { status: 404 }
      );
    }

    const definition = getIntegration(integrationId)!;

    // Delete the integration
    const result = await db
      .delete(userIntegrations)
      .where(
        and(
          eq(userIntegrations.userId, userId),
          eq(userIntegrations.integrationId, integrationId)
        )
      )
      .returning();

    if (result.length === 0) {
      return NextResponse.json(
        { error: 'Integration not found' },
        { status: 404 }
      );
    }

    integrationsLogger.info('Integration removed', {
      userId,
      integrationId,
    });

    return new Response(null, { status: 204 });
  } catch (error) {
    integrationsLogger.error('Failed to remove integration', error as Error);
    return NextResponse.json(
      { error: 'Failed to remove integration' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/settings/integrations/[integrationId]/validate
 * Validate integration credentials
 */
export async function POST(
  request: Request,
  context: RouteParams
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { integrationId } = await context.params;

    // Validate integration ID
    if (!isValidIntegrationId(integrationId)) {
      return NextResponse.json(
        { error: `Unknown integration: ${integrationId}` },
        { status: 404 }
      );
    }

    const definition = getIntegration(integrationId)!;

    // Get existing configuration
    const [existing] = await db
      .select()
      .from(userIntegrations)
      .where(
        and(
          eq(userIntegrations.userId, userId),
          eq(userIntegrations.integrationId, integrationId)
        )
      );

    if (!existing) {
      return NextResponse.json(
        { error: 'Integration not configured' },
        { status: 404 }
      );
    }

    // Decrypt API key
    let apiKey: string | undefined;
    if (existing.encryptedApiKey) {
      apiKey = await decrypt(existing.encryptedApiKey);
    }

    // Validate
    let validationStatus: string;
    let validationMessage: string;

    try {
      const result = await definition.validate(
        (existing.config as Record<string, unknown>) || {},
        apiKey
      );
      validationStatus = result.valid ? 'valid' : 'invalid';
      validationMessage = result.message;
    } catch (error) {
      validationStatus = 'invalid';
      validationMessage = error instanceof Error ? error.message : 'Validation failed';
    }

    // Update validation status
    await db
      .update(userIntegrations)
      .set({
        validationStatus,
        validationMessage,
        lastValidatedAt: new Date(),
      })
      .where(eq(userIntegrations.id, existing.id));

    integrationsLogger.info('Integration validated', {
      userId,
      integrationId,
      validationStatus,
    });

    return NextResponse.json({
      success: validationStatus === 'valid',
      validationStatus,
      validationMessage,
      validatedAt: new Date().toISOString(),
    });
  } catch (error) {
    integrationsLogger.error('Failed to validate integration', error as Error);
    return NextResponse.json(
      { error: 'Failed to validate integration' },
      { status: 500 }
    );
  }
}
