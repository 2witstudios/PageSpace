/**
 * Personalization utilities for AI system prompt injection
 */

import { db, userPersonalization, eq } from '@pagespace/db';
import type { PersonalizationInfo } from './system-prompt';

/**
 * Fetch user personalization settings from the database
 * Returns null if personalization is disabled or not configured
 */
export async function getUserPersonalization(
  userId: string
): Promise<PersonalizationInfo | null> {
  try {
    const personalization = await db.query.userPersonalization.findFirst({
      where: eq(userPersonalization.userId, userId),
    });

    if (!personalization) {
      return null;
    }

    // Return null if disabled
    if (!personalization.enabled) {
      return null;
    }

    return {
      bio: personalization.bio ?? undefined,
      writingStyle: personalization.writingStyle ?? undefined,
      rules: personalization.rules ?? undefined,
      enabled: personalization.enabled,
    };
  } catch (error) {
    // Log error but don't fail - personalization is optional
    console.error('Failed to fetch user personalization:', error);
    return null;
  }
}
