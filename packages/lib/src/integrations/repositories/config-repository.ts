/**
 * Config Repository
 *
 * Database operations for global assistant configuration.
 * Each user has a single config row for their global assistant preferences.
 */

import {
  db as defaultDb,
  eq,
  globalAssistantConfig,
  type GlobalAssistantConfig,
} from '@pagespace/db';

/**
 * Get or create a global assistant config for a user.
 * Returns existing config or creates a new one with defaults.
 */
export const getOrCreateConfig = async (
  database: typeof defaultDb,
  userId: string
): Promise<GlobalAssistantConfig> => {
  const existing = await database.query.globalAssistantConfig.findFirst({
    where: eq(globalAssistantConfig.userId, userId),
  });

  if (existing) return existing;

  // Use onConflictDoNothing to handle concurrent inserts for the same userId
  const rows = await database
    .insert(globalAssistantConfig)
    .values({
      userId,
      enabledUserIntegrations: null,
      driveOverrides: {},
      inheritDriveIntegrations: true,
    })
    .onConflictDoNothing({ target: globalAssistantConfig.userId })
    .returning();

  // If conflict occurred, re-fetch the existing row
  if (rows.length === 0) {
    const refetched = await database.query.globalAssistantConfig.findFirst({
      where: eq(globalAssistantConfig.userId, userId),
    });
    return refetched!;
  }

  return rows[0];
};

/**
 * Get a global assistant config for a user.
 * Returns null if no config exists.
 */
export const getConfig = async (
  database: typeof defaultDb,
  userId: string
): Promise<GlobalAssistantConfig | null> => {
  const config = await database.query.globalAssistantConfig.findFirst({
    where: eq(globalAssistantConfig.userId, userId),
  });

  return config ?? null;
};

/**
 * Update a global assistant config.
 * Creates the config if it doesn't exist.
 */
export const updateConfig = async (
  database: typeof defaultDb,
  userId: string,
  data: Partial<Pick<GlobalAssistantConfig, 'enabledUserIntegrations' | 'driveOverrides' | 'inheritDriveIntegrations'>>
): Promise<GlobalAssistantConfig> => {
  // Ensure config exists (race-safe)
  await getOrCreateConfig(database, userId);

  const [updated] = await database
    .update(globalAssistantConfig)
    .set(data)
    .where(eq(globalAssistantConfig.userId, userId))
    .returning();

  return updated;
};
