/**
 * PageSpace Integration Registry
 *
 * Central registry of all available integrations. New integrations are added
 * by creating a definition file in ./definitions/ and registering it here.
 */

import type { IntegrationDefinition, IntegrationCategory } from './types';
import { apifyIntegration } from './definitions/apify';

/**
 * Registry of all available integrations
 * Add new integrations here after creating their definition
 */
const integrationDefinitions: IntegrationDefinition[] = [
  apifyIntegration,
  // Add new integrations here:
  // zapierIntegration,
  // slackIntegration,
  // etc.
];

/**
 * Map for O(1) lookup by ID
 */
const integrationMap = new Map<string, IntegrationDefinition>(
  integrationDefinitions.map(def => [def.id, def])
);

/**
 * Get all registered integrations
 */
export function getAllIntegrations(): IntegrationDefinition[] {
  return [...integrationDefinitions];
}

/**
 * Get an integration definition by ID
 */
export function getIntegration(id: string): IntegrationDefinition | undefined {
  return integrationMap.get(id);
}

/**
 * Get integrations by category
 */
export function getIntegrationsByCategory(category: IntegrationCategory): IntegrationDefinition[] {
  return integrationDefinitions.filter(def => def.category === category);
}

/**
 * Check if an integration ID is valid
 */
export function isValidIntegrationId(id: string): boolean {
  return integrationMap.has(id);
}

/**
 * Get all integration IDs
 */
export function getIntegrationIds(): string[] {
  return integrationDefinitions.map(def => def.id);
}

/**
 * Get tool names for an integration
 */
export function getIntegrationToolNames(integrationId: string): string[] {
  const integration = getIntegration(integrationId);
  if (!integration) return [];
  return integration.tools.map(t => t.name);
}

/**
 * Find which integration provides a given tool
 */
export function getIntegrationByToolName(toolName: string): IntegrationDefinition | undefined {
  return integrationDefinitions.find(def =>
    def.tools.some(t => t.name === toolName)
  );
}

/**
 * Get all tools from all integrations (metadata only)
 */
export function getAllIntegrationTools(): Array<{
  integrationId: string;
  integrationName: string;
  tool: IntegrationDefinition['tools'][number];
}> {
  return integrationDefinitions.flatMap(def =>
    def.tools.map(tool => ({
      integrationId: def.id,
      integrationName: def.name,
      tool,
    }))
  );
}
