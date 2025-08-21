import { db, userAiSettings, eq, and } from '@pagespace/db';
import { decrypt } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';

// Note: Message persistence is now handled by ChatStorageAdapter
// This file only contains AI provider settings management

/**
 * Gets default PageSpace API settings
 * Returns the default OpenRouter API key configured for the app
 */
export async function getDefaultPageSpaceSettings(): Promise<{
  apiKey: string;
  isConfigured: boolean;
} | null> {
  const defaultApiKey = process.env.OPENROUTER_DEFAULT_API_KEY;
  
  if (!defaultApiKey) {
    return null;
  }
  
  return {
    apiKey: defaultApiKey,
    isConfigured: true,
  };
}

/**
 * Gets user's OpenRouter API settings
 * Returns decrypted API key for use with OpenRouter provider
 */
export async function getUserOpenRouterSettings(userId: string): Promise<{
  apiKey: string;
  isConfigured: boolean;
} | null> {
  const settings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'openrouter')
    ),
  });

  if (!settings || !settings.encryptedApiKey) {
    return null;
  }

  try {
    const apiKey = await decrypt(settings.encryptedApiKey);
    return {
      apiKey,
      isConfigured: true,
    };
  } catch (error) {
    console.error('Failed to decrypt OpenRouter API key:', error);
    return null;
  }
}

/**
 * Creates OpenRouter provider settings for a user
 * Encrypts and stores the API key securely
 */
export async function createOpenRouterSettings(
  userId: string,
  apiKey: string
): Promise<void> {
  const { encrypt } = await import('@pagespace/lib/server');
  const encryptedApiKey = await encrypt(apiKey);

  // Check if settings already exist
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'openrouter')
    ),
  });

  if (existingSettings) {
    // Update existing settings
    await db
      .update(userAiSettings)
      .set({
        encryptedApiKey,
        updatedAt: new Date(),
      })
      .where(eq(userAiSettings.id, existingSettings.id));
  } else {
    // Create new settings
    await db.insert(userAiSettings).values({
      id: createId(),
      userId,
      provider: 'openrouter',
      encryptedApiKey,
    });
  }
}

/**
 * Gets user's Google AI API settings
 * Returns decrypted API key for use with Google AI provider
 */
export async function getUserGoogleSettings(userId: string): Promise<{
  apiKey: string;
  isConfigured: boolean;
} | null> {
  const settings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'google')
    ),
  });

  if (!settings || !settings.encryptedApiKey) {
    return null;
  }

  try {
    const apiKey = await decrypt(settings.encryptedApiKey);
    return {
      apiKey,
      isConfigured: true,
    };
  } catch (error) {
    console.error('Failed to decrypt Google API key:', error);
    return null;
  }
}

/**
 * Creates Google AI provider settings for a user
 * Encrypts and stores the API key securely
 */
export async function createGoogleSettings(
  userId: string,
  apiKey: string
): Promise<void> {
  const { encrypt } = await import('@pagespace/lib/server');
  const encryptedApiKey = await encrypt(apiKey);

  // Check if settings already exist
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'google')
    ),
  });

  if (existingSettings) {
    // Update existing settings
    await db
      .update(userAiSettings)
      .set({
        encryptedApiKey,
        updatedAt: new Date(),
      })
      .where(eq(userAiSettings.id, existingSettings.id));
  } else {
    // Create new settings
    await db.insert(userAiSettings).values({
      id: createId(),
      userId,
      provider: 'google',
      encryptedApiKey,
    });
  }
}

/**
 * Deletes OpenRouter provider settings for a user
 * Removes the encrypted API key from database
 */
export async function deleteOpenRouterSettings(userId: string): Promise<void> {
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'openrouter')
    ),
  });

  if (existingSettings) {
    await db
      .delete(userAiSettings)
      .where(eq(userAiSettings.id, existingSettings.id));
  }
}

/**
 * Deletes Google AI provider settings for a user
 * Removes the encrypted API key from database
 */
export async function deleteGoogleSettings(userId: string): Promise<void> {
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'google')
    ),
  });

  if (existingSettings) {
    await db
      .delete(userAiSettings)
      .where(eq(userAiSettings.id, existingSettings.id));
  }
}

/**
 * Gets user's OpenAI API settings
 * Returns decrypted API key for use with OpenAI provider
 */
export async function getUserOpenAISettings(userId: string): Promise<{
  apiKey: string;
  isConfigured: boolean;
} | null> {
  const settings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'openai')
    ),
  });

  if (!settings || !settings.encryptedApiKey) {
    return null;
  }

  try {
    const apiKey = await decrypt(settings.encryptedApiKey);
    return {
      apiKey,
      isConfigured: true,
    };
  } catch (error) {
    console.error('Failed to decrypt OpenAI API key:', error);
    return null;
  }
}

/**
 * Creates OpenAI provider settings for a user
 * Encrypts and stores the API key securely
 */
export async function createOpenAISettings(
  userId: string,
  apiKey: string
): Promise<void> {
  const { encrypt } = await import('@pagespace/lib/server');
  const encryptedApiKey = await encrypt(apiKey);

  // Check if settings already exist
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'openai')
    ),
  });

  if (existingSettings) {
    // Update existing settings
    await db
      .update(userAiSettings)
      .set({
        encryptedApiKey,
        updatedAt: new Date(),
      })
      .where(eq(userAiSettings.id, existingSettings.id));
  } else {
    // Create new settings
    await db.insert(userAiSettings).values({
      id: createId(),
      userId,
      provider: 'openai',
      encryptedApiKey,
    });
  }
}

/**
 * Deletes OpenAI provider settings for a user
 * Removes the encrypted API key from database
 */
export async function deleteOpenAISettings(userId: string): Promise<void> {
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'openai')
    ),
  });

  if (existingSettings) {
    await db
      .delete(userAiSettings)
      .where(eq(userAiSettings.id, existingSettings.id));
  }
}

/**
 * Gets user's Anthropic API settings
 * Returns decrypted API key for use with Anthropic provider
 */
export async function getUserAnthropicSettings(userId: string): Promise<{
  apiKey: string;
  isConfigured: boolean;
} | null> {
  const settings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'anthropic')
    ),
  });

  if (!settings || !settings.encryptedApiKey) {
    return null;
  }

  try {
    const apiKey = await decrypt(settings.encryptedApiKey);
    return {
      apiKey,
      isConfigured: true,
    };
  } catch (error) {
    console.error('Failed to decrypt Anthropic API key:', error);
    return null;
  }
}

/**
 * Creates Anthropic provider settings for a user
 * Encrypts and stores the API key securely
 */
export async function createAnthropicSettings(
  userId: string,
  apiKey: string
): Promise<void> {
  const { encrypt } = await import('@pagespace/lib/server');
  const encryptedApiKey = await encrypt(apiKey);

  // Check if settings already exist
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'anthropic')
    ),
  });

  if (existingSettings) {
    // Update existing settings
    await db
      .update(userAiSettings)
      .set({
        encryptedApiKey,
        updatedAt: new Date(),
      })
      .where(eq(userAiSettings.id, existingSettings.id));
  } else {
    // Create new settings
    await db.insert(userAiSettings).values({
      id: createId(),
      userId,
      provider: 'anthropic',
      encryptedApiKey,
    });
  }
}

/**
 * Deletes Anthropic provider settings for a user
 * Removes the encrypted API key from database
 */
export async function deleteAnthropicSettings(userId: string): Promise<void> {
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'anthropic')
    ),
  });

  if (existingSettings) {
    await db
      .delete(userAiSettings)
      .where(eq(userAiSettings.id, existingSettings.id));
  }
}

/**
 * Gets user's xAI API settings
 * Returns decrypted API key for use with xAI provider
 */
export async function getUserXAISettings(userId: string): Promise<{
  apiKey: string;
  isConfigured: boolean;
} | null> {
  const settings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'xai')
    ),
  });

  if (!settings || !settings.encryptedApiKey) {
    return null;
  }

  try {
    const apiKey = await decrypt(settings.encryptedApiKey);
    return {
      apiKey,
      isConfigured: true,
    };
  } catch (error) {
    console.error('Failed to decrypt xAI API key:', error);
    return null;
  }
}

/**
 * Creates xAI provider settings for a user
 * Encrypts and stores the API key securely
 */
export async function createXAISettings(
  userId: string,
  apiKey: string
): Promise<void> {
  const { encrypt } = await import('@pagespace/lib/server');
  const encryptedApiKey = await encrypt(apiKey);

  // Check if settings already exist
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'xai')
    ),
  });

  if (existingSettings) {
    // Update existing settings
    await db
      .update(userAiSettings)
      .set({
        encryptedApiKey,
        updatedAt: new Date(),
      })
      .where(eq(userAiSettings.id, existingSettings.id));
  } else {
    // Create new settings
    await db.insert(userAiSettings).values({
      id: createId(),
      userId,
      provider: 'xai',
      encryptedApiKey,
    });
  }
}

/**
 * Deletes xAI provider settings for a user
 * Removes the encrypted API key from database
 */
export async function deleteXAISettings(userId: string): Promise<void> {
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'xai')
    ),
  });

  if (existingSettings) {
    await db
      .delete(userAiSettings)
      .where(eq(userAiSettings.id, existingSettings.id));
  }
}

// Note: Message management functions are now in ChatStorageAdapter
// This provides a cleaner separation of concerns