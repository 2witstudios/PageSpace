/**
 * Provider Repository
 *
 * Database operations for integration providers.
 * Handles listing, creating, updating, and deleting provider configurations.
 */

import { db as defaultDb } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { integrationProviders, integrationConnections, type IntegrationProvider, type NewIntegrationProvider } from '@pagespace/db/schema/integrations';
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
    columns: { slug: true },
  });

  const installedSlugs = new Set(existing.map((p) => p.slug));
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
 * Deterministic JSON serialization with sorted keys at all levels.
 * Needed because PostgreSQL JSONB does not preserve key order.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const sorted = Object.keys(value as Record<string, unknown>).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${sorted.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Refresh builtin provider configs from the in-memory definitions.
 * Compares the full config (tools, schemas, rate limits, etc.) via stable
 * JSON serialization. Only touches providers with providerType 'builtin'.
 */
export const refreshBuiltinProviders = async (
  database: typeof defaultDb,
  builtins: IntegrationProviderConfig[]
): Promise<number> => {
  let updated = 0;

  for (const builtin of builtins) {
    const existing = await database.query.integrationProviders.findFirst({
      where: and(
        eq(integrationProviders.slug, builtin.id),
        eq(integrationProviders.providerType, 'builtin')
      ),
    });
    if (!existing) continue;

    if (stableStringify(existing.config) === stableStringify(builtin)) continue;

    await database
      .update(integrationProviders)
      .set({ config: builtin as unknown as Record<string, unknown> })
      .where(eq(integrationProviders.id, existing.id));
    updated++;
  }

  return updated;
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
