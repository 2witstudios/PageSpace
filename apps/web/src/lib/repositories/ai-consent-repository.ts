/**
 * Repository seam for AI provider consent operations.
 */

import { db, eq, and, isNull } from '@pagespace/db';
import { aiProviderConsents } from '@pagespace/db';

export const aiConsentRepository = {
  /**
   * Check if user has active (non-revoked) consent for a provider.
   */
  async hasConsent(userId: string, provider: string): Promise<boolean> {
    const consent = await db.query.aiProviderConsents.findFirst({
      where: and(
        eq(aiProviderConsents.userId, userId),
        eq(aiProviderConsents.provider, provider),
        isNull(aiProviderConsents.revokedAt),
      ),
    });
    return !!consent;
  },

  /**
   * Grant consent for a provider. Uses upsert to handle re-consenting.
   */
  async grantConsent(userId: string, provider: string): Promise<void> {
    await db
      .insert(aiProviderConsents)
      .values({
        userId,
        provider,
        consentedAt: new Date(),
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: [aiProviderConsents.userId, aiProviderConsents.provider],
        set: {
          consentedAt: new Date(),
          revokedAt: null,
        },
      });
  },

  /**
   * Revoke consent for a provider.
   */
  async revokeConsent(userId: string, provider: string): Promise<void> {
    await db
      .update(aiProviderConsents)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(aiProviderConsents.userId, userId),
          eq(aiProviderConsents.provider, provider),
        )
      );
  },

  /**
   * Get all consent records for a user.
   */
  async getConsents(userId: string) {
    return db.query.aiProviderConsents.findMany({
      where: eq(aiProviderConsents.userId, userId),
      columns: {
        id: true,
        provider: true,
        consentedAt: true,
        revokedAt: true,
      },
    });
  },
};
