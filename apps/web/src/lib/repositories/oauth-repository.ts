/**
 * Repository for OAuth and signup flow database operations.
 * Isolates AI settings provisioning and drive creation from route handlers,
 * enabling proper unit testing without ORM chain mocking.
 */

import {
  db,
  userAiSettings,
  drives,
  type InferSelectModel,
} from '@pagespace/db';

export const oauthRepository = {
  /**
   * Create default AI settings for a new user (ollama provider).
   * Called during signup flows (web, passkey, mobile).
   */
  async createDefaultAiSettings(userId: string): Promise<void> {
    await db.insert(userAiSettings).values({
      userId,
      provider: 'ollama',
      baseUrl: 'http://host.docker.internal:11434',
      updatedAt: new Date(),
    });
  },

  /**
   * Create a personal drive for a new user.
   * Used by mobile signup flow.
   */
  async createPersonalDrive(data: {
    name: string;
    slug: string;
    ownerId: string;
  }): Promise<InferSelectModel<typeof drives>> {
    const results = await db
      .insert(drives)
      .values({
        ...data,
        updatedAt: new Date(),
      })
      .returning();
    return results[0];
  },
};

export type OAuthRepository = typeof oauthRepository;
