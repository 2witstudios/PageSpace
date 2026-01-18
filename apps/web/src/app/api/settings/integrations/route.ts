/**
 * API Routes for Integration Management
 *
 * GET  /api/settings/integrations - List all integrations and their status
 * POST /api/settings/integrations - Configure a new integration
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers, encrypt } from '@pagespace/lib/server';
import { db, userIntegrations, eq, and } from '@pagespace/db';
import {
  getAllIntegrations,
  getIntegration,
  isValidIntegrationId,
  configureIntegrationSchema,
} from '@/lib/integrations';
import type { IntegrationStatus } from '@/lib/integrations';
import { getUserIntegrations } from '@/lib/integrations/tool-loader';

const integrationsLogger = loggers.api.child({ module: 'integrations' });

const AUTH_OPTIONS_READ = { allow: ['jwt'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * GET /api/settings/integrations
 * Returns all available integrations and user's configuration status
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get all available integrations
    const allIntegrations = getAllIntegrations();

    // Get user's configured integrations
    const userConfigs = await getUserIntegrations(userId);
    const userConfigMap = new Map(
      userConfigs.map(config => [config.integrationId, config])
    );

    // Build status for each integration
    const integrationStatuses: IntegrationStatus[] = allIntegrations.map(definition => {
      const userConfig = userConfigMap.get(definition.id);
      const isConfigured = !!userConfig;
      const isEnabled = userConfig?.enabled ?? false;

      // Determine which tools are enabled
      const enabledToolNames = userConfig?.enabledTools;
      const enabledTools = enabledToolNames
        ? definition.tools.filter(t => enabledToolNames.includes(t.name))
        : isEnabled ? definition.tools : [];

      return {
        definition,
        userConfig,
        isConfigured,
        isEnabled,
        availableTools: definition.tools,
        enabledTools,
      };
    });

    return NextResponse.json({
      integrations: integrationStatuses,
      configuredCount: userConfigs.length,
      enabledCount: userConfigs.filter(c => c.enabled).length,
    });
  } catch (error) {
    integrationsLogger.error('Failed to get integrations', error as Error);
    return NextResponse.json(
      { error: 'Failed to retrieve integrations' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/settings/integrations
 * Configure a new integration
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();

    // Validate input
    const parseResult = configureIntegrationSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request', details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const { integrationId, apiKey, config, enabledTools } = parseResult.data;

    // Validate integration ID
    if (!isValidIntegrationId(integrationId)) {
      return NextResponse.json(
        { error: `Unknown integration: ${integrationId}` },
        { status: 400 }
      );
    }

    const definition = getIntegration(integrationId)!;

    // Check if API key is required
    if (definition.requiresApiKey && !apiKey) {
      return NextResponse.json(
        { error: `${definition.name} requires an API key` },
        { status: 400 }
      );
    }

    // Check if integration already exists for this user
    const [existing] = await db
      .select()
      .from(userIntegrations)
      .where(
        and(
          eq(userIntegrations.userId, userId),
          eq(userIntegrations.integrationId, integrationId)
        )
      );

    if (existing) {
      return NextResponse.json(
        { error: 'Integration already configured. Use PATCH to update.' },
        { status: 409 }
      );
    }

    // Encrypt API key if provided
    let encryptedApiKey: string | null = null;
    if (apiKey) {
      encryptedApiKey = await encrypt(apiKey.trim());
    }

    // Validate credentials if provided
    let validationStatus: string = 'unknown';
    let validationMessage: string | null = null;
    let lastValidatedAt: Date | null = null;

    if (apiKey) {
      try {
        const validationResult = await definition.validate(config || {}, apiKey);
        validationStatus = validationResult.valid ? 'valid' : 'invalid';
        validationMessage = validationResult.message;
        lastValidatedAt = new Date();
      } catch (error) {
        validationStatus = 'invalid';
        validationMessage = error instanceof Error ? error.message : 'Validation failed';
        lastValidatedAt = new Date();
      }
    }

    // Create the integration
    const [created] = await db
      .insert(userIntegrations)
      .values({
        userId,
        integrationId,
        enabled: validationStatus === 'valid',
        encryptedApiKey,
        config: config || {},
        enabledTools: enabledTools || null,
        validationStatus,
        validationMessage,
        lastValidatedAt,
      })
      .returning();

    integrationsLogger.info('Integration configured', {
      userId,
      integrationId,
      validationStatus,
    });

    return NextResponse.json(
      {
        success: true,
        integration: {
          id: created.id,
          integrationId: created.integrationId,
          enabled: created.enabled,
          validationStatus: created.validationStatus,
          validationMessage: created.validationMessage,
        },
        message: validationStatus === 'valid'
          ? `${definition.name} configured and enabled successfully`
          : `${definition.name} configured but credentials are ${validationStatus}`,
      },
      { status: 201 }
    );
  } catch (error) {
    integrationsLogger.error('Failed to configure integration', error as Error);
    return NextResponse.json(
      { error: 'Failed to configure integration' },
      { status: 500 }
    );
  }
}
