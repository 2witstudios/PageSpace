/**
 * Repository seam for AI settings-related user operations.
 *
 * This provides a clean boundary between routes and DB operations,
 * making route handlers independently testable without ORM chain mocking.
 */

import { db, users, eq } from '@pagespace/db';

// Types for user AI settings
export interface UserAISettings {
  id: string;
  currentAiProvider: string | null;
  currentAiModel: string | null;
  subscriptionTier: string | null;
}

export interface UpdateProviderSettingsInput {
  provider: string;
  model?: string;
}

/**
 * Repository for AI settings user operations.
 * Encapsulates database queries for testability.
 */
export const aiSettingsRepository = {
  /**
   * Get user's AI-related settings (provider, model, subscription tier).
   */
  async getUserSettings(userId: string): Promise<UserAISettings | null> {
    const [user] = await db
      .select({
        id: users.id,
        currentAiProvider: users.currentAiProvider,
        currentAiModel: users.currentAiModel,
        subscriptionTier: users.subscriptionTier,
      })
      .from(users)
      .where(eq(users.id, userId));

    return user || null;
  },

  /**
   * Update user's current AI provider and model selection.
   * Model can be undefined for local providers (ollama, lmstudio) where models are discovered dynamically.
   */
  async updateProviderSettings(
    userId: string,
    settings: UpdateProviderSettingsInput
  ): Promise<void> {
    const updateData: { currentAiProvider: string; currentAiModel?: string } = {
      currentAiProvider: settings.provider,
    };

    // Only update model if explicitly provided
    if (settings.model) {
      updateData.currentAiModel = settings.model;
    }

    await db.update(users).set(updateData).where(eq(users.id, userId));
  },
};
