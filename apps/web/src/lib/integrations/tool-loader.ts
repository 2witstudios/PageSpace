/**
 * Integration Tool Loader
 *
 * Loads AI tools from user-configured integrations.
 * Fetches user's enabled integrations from DB and creates tool instances.
 */

import { db, userIntegrations, eq, and } from '@pagespace/db';
import { decrypt } from '@pagespace/lib/server';
import type { Tool } from 'ai';
import { getIntegration } from './registry';
import type { IntegrationToolContext, UserIntegrationConfig } from './types';

/**
 * Get user's configured integrations from database
 */
export async function getUserIntegrations(userId: string): Promise<UserIntegrationConfig[]> {
  const integrations = await db
    .select()
    .from(userIntegrations)
    .where(eq(userIntegrations.userId, userId));

  return integrations.map(integration => ({
    id: integration.id,
    integrationId: integration.integrationId,
    name: integration.name ?? undefined,
    enabled: integration.enabled,
    config: (integration.config as Record<string, unknown>) || {},
    enabledTools: integration.enabledTools as string[] | null,
    lastValidatedAt: integration.lastValidatedAt ?? undefined,
    validationStatus: integration.validationStatus as 'valid' | 'invalid' | 'unknown' | undefined,
    validationMessage: integration.validationMessage ?? undefined,
  }));
}

/**
 * Get a specific user integration
 */
export async function getUserIntegration(
  userId: string,
  integrationId: string
): Promise<UserIntegrationConfig | undefined> {
  const [integration] = await db
    .select()
    .from(userIntegrations)
    .where(
      and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.integrationId, integrationId)
      )
    );

  if (!integration) return undefined;

  return {
    id: integration.id,
    integrationId: integration.integrationId,
    name: integration.name ?? undefined,
    enabled: integration.enabled,
    config: (integration.config as Record<string, unknown>) || {},
    enabledTools: integration.enabledTools as string[] | null,
    lastValidatedAt: integration.lastValidatedAt ?? undefined,
    validationStatus: integration.validationStatus as 'valid' | 'invalid' | 'unknown' | undefined,
    validationMessage: integration.validationMessage ?? undefined,
  };
}

/**
 * Load tools from a single integration
 */
export async function loadIntegrationTools(
  userId: string,
  userConfig: UserIntegrationConfig
): Promise<Record<string, Tool>> {
  // Skip if not enabled
  if (!userConfig.enabled) {
    return {};
  }

  // Get the integration definition
  const definition = getIntegration(userConfig.integrationId);
  if (!definition) {
    console.warn(`Unknown integration: ${userConfig.integrationId}`);
    return {};
  }

  // Get the full integration record to decrypt API key
  const [record] = await db
    .select()
    .from(userIntegrations)
    .where(
      and(
        eq(userIntegrations.userId, userId),
        eq(userIntegrations.integrationId, userConfig.integrationId)
      )
    );

  // Decrypt API key if present
  let apiKey: string | undefined;
  if (record?.encryptedApiKey) {
    try {
      apiKey = await decrypt(record.encryptedApiKey);
    } catch (error) {
      console.error(`Failed to decrypt API key for integration ${userConfig.integrationId}:`, error);
      return {};
    }
  }

  // Skip if integration requires API key but none is configured
  if (definition.requiresApiKey && !apiKey) {
    return {};
  }

  // Create tool context
  const context: IntegrationToolContext = {
    config: userConfig.config,
    apiKey,
    userId,
  };

  // Create tools from the integration
  const allTools = definition.createTools(context);

  // Filter to only enabled tools if specific tools are enabled
  if (userConfig.enabledTools && userConfig.enabledTools.length > 0) {
    const enabledSet = new Set(userConfig.enabledTools);
    return Object.fromEntries(
      Object.entries(allTools).filter(([name]) => enabledSet.has(name))
    );
  }

  return allTools;
}

/**
 * Load all integration tools for a user
 * Returns a combined record of all tools from enabled integrations
 */
export async function getUserIntegrationTools(
  userId: string
): Promise<Record<string, Tool>> {
  const userConfigs = await getUserIntegrations(userId);

  // Load tools from all enabled integrations in parallel
  const toolPromises = userConfigs
    .filter(config => config.enabled)
    .map(config => loadIntegrationTools(userId, config));

  const toolArrays = await Promise.all(toolPromises);

  // Merge all tools into a single record
  return Object.assign({}, ...toolArrays);
}

/**
 * Get names of all tools available to a user from integrations
 */
export async function getUserIntegrationToolNames(userId: string): Promise<string[]> {
  const tools = await getUserIntegrationTools(userId);
  return Object.keys(tools);
}

/**
 * Check if user has a specific integration configured and enabled
 */
export async function isIntegrationEnabled(
  userId: string,
  integrationId: string
): Promise<boolean> {
  const config = await getUserIntegration(userId, integrationId);
  return config?.enabled ?? false;
}
