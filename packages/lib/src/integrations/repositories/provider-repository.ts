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
import type { IntegrationProviderConfig } from '../types';

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
 * Seed builtin providers that are not yet installed.
 * Idempotent — skips providers whose slug already exists in the database.
 */
export const seedBuiltinProviders = async (
  database: typeof defaultDb,
  builtins: IntegrationProviderConfig[]
): Promise<IntegrationProvider[]> => {
  const existing = await database.query.integrationProviders.findMany({
    where: eq(integrationProviders.enabled, true),
  });

  const installedSlugs = new Set(existing.map((p: IntegrationProvider) => p.slug));
  const toSeed = builtins.filter((b) => !installedSlugs.has(b.id));

  if (toSeed.length === 0) return [];

  const seeded: IntegrationProvider[] = [];
  for (const builtin of toSeed) {
    const [provider] = await database
      .insert(integrationProviders)
      .values({
        slug: builtin.id,
        name: builtin.name,
        description: builtin.description ?? null,
        iconUrl: builtin.iconUrl ?? null,
        documentationUrl: builtin.documentationUrl ?? null,
        providerType: 'builtin',
        config: builtin as unknown as Record<string, unknown>,
        isSystem: true,
        enabled: true,
      })
      .returning();
    seeded.push(provider);
  }

  return seeded;
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
