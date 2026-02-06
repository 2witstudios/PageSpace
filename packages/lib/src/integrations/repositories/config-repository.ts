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

  const [created] = await database
    .insert(globalAssistantConfig)
    .values({
      userId,
      enabledUserIntegrations: null,
      driveOverrides: {},
      inheritDriveIntegrations: true,
    })
    .returning();

  return created;
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
  // Try to get existing config
  const existing = await getConfig(database, userId);

  if (existing) {
    const [updated] = await database
      .update(globalAssistantConfig)
      .set(data)
      .where(eq(globalAssistantConfig.userId, userId))
      .returning();

    return updated;
  }

  // Create new config with provided data
  const [created] = await database
    .insert(globalAssistantConfig)
    .values({
      userId,
      enabledUserIntegrations: data.enabledUserIntegrations ?? null,
      driveOverrides: data.driveOverrides ?? {},
      inheritDriveIntegrations: data.inheritDriveIntegrations ?? true,
    })
    .returning();

  return created;
};
