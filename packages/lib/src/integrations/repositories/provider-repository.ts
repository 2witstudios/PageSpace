/**
 * Provider Repository
 *
 * Database operations for integration providers.
 * Handles listing, creating, updating, and deleting provider configurations.
 */

import {
  db as defaultDb,
  eq,
  and,
  integrationProviders,
  integrationConnections,
  type IntegrationProvider,
  type NewIntegrationProvider,
} from '@pagespace/db';

/**
 * Get a provider by ID.
 */
export const getProviderById = async (
  database: typeof defaultDb,
  providerId: string
): Promise<IntegrationProvider | null> => {
  const provider = await database.query.integrationProviders.findFirst({
    where: eq(integrationProviders.id, providerId),
  });

  return provider ?? null;
};

/**
 * Get a provider by slug.
 */
export const getProviderBySlug = async (
  database: typeof defaultDb,
  slug: string
): Promise<IntegrationProvider | null> => {
  const provider = await database.query.integrationProviders.findFirst({
    where: eq(integrationProviders.slug, slug),
  });

  return provider ?? null;
};

/**
 * List all enabled providers.
 * Returns system providers + user-created custom providers.
 */
export const listEnabledProviders = async (
  database: typeof defaultDb
): Promise<IntegrationProvider[]> => {
  const providers = await database.query.integrationProviders.findMany({
    where: eq(integrationProviders.enabled, true),
  });

  return providers;
};

/**
 * List providers for a specific drive (system + drive-specific).
 */
export const listProvidersForDrive = async (
  database: typeof defaultDb,
  driveId: string
): Promise<IntegrationProvider[]> => {
  const providers = await database.query.integrationProviders.findMany({
    where: and(
      eq(integrationProviders.enabled, true),
    ),
  });

  // Return system providers + drive-specific providers
  return providers.filter(
    (p: IntegrationProvider) => p.isSystem || p.driveId === driveId || p.driveId === null
  );
};

/**
 * Create a new provider.
 */
export const createProvider = async (
  database: typeof defaultDb,
  data: NewIntegrationProvider
): Promise<IntegrationProvider> => {
  const [provider] = await database
    .insert(integrationProviders)
    .values(data)
    .returning();

  return provider;
};

/**
 * Update a provider.
 */
export const updateProvider = async (
  database: typeof defaultDb,
  providerId: string,
  data: Partial<Pick<IntegrationProvider, 'name' | 'description' | 'iconUrl' | 'documentationUrl' | 'config' | 'enabled'>>
): Promise<IntegrationProvider | null> => {
  const [updated] = await database
    .update(integrationProviders)
    .set(data)
    .where(eq(integrationProviders.id, providerId))
    .returning();

  return updated ?? null;
};

/**
 * Delete a provider by ID.
 * Returns null if provider has active connections (prevent deletion).
 */
export const deleteProvider = async (
  database: typeof defaultDb,
  providerId: string
): Promise<IntegrationProvider | null> => {
  // Check for active connections
  const connections = await database.query.integrationConnections.findMany({
    where: eq(integrationConnections.providerId, providerId),
    columns: { id: true },
    limit: 1,
  });

  if (connections.length > 0) {
    return null;
  }

  const [deleted] = await database
    .delete(integrationProviders)
    .where(eq(integrationProviders.id, providerId))
    .returning();

  return deleted ?? null;
};

/**
 * Count connections for a provider.
 */
export const countProviderConnections = async (
  database: typeof defaultDb,
  providerId: string
): Promise<number> => {
  const connections = await database.query.integrationConnections.findMany({
    where: eq(integrationConnections.providerId, providerId),
    columns: { id: true },
  });

  return connections.length;
};
