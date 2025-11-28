import { db, userAiSettings, eq, and } from '@pagespace/db';
import { decrypt } from '@pagespace/lib/server';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/server';
import { maskIdentifier } from '@/lib/logging/mask';

const aiLogger = loggers.ai.child({ module: 'ai-utils' });

// Note: Message persistence is now handled by ChatStorageAdapter
// This file only contains AI provider settings management

/**
 * Gets default PageSpace API settings
 * Returns the default GLM API key configured for the app (GLM 4.5 Air/Standard)
 */
export async function getDefaultPageSpaceSettings(): Promise<{
  apiKey: string;
  isConfigured: boolean;
  provider: 'glm' | 'google' | 'openrouter';
} | null> {
  // First try GLM (current default for PageSpace)
  const glmApiKey = process.env.GLM_DEFAULT_API_KEY;
  if (glmApiKey && glmApiKey !== 'your_glm_api_key_here') {
    return {
      apiKey: glmApiKey,
      isConfigured: true,
      provider: 'glm',
    };
  }

  // Fallback to Google AI for backwards compatibility
  const googleApiKey = process.env.GOOGLE_AI_DEFAULT_API_KEY;
  if (googleApiKey && googleApiKey !== 'your_google_ai_api_key_here') {
    return {
      apiKey: googleApiKey,
      isConfigured: true,
      provider: 'google',
    };
  }

  // Fallback to OpenRouter for backwards compatibility
  const openRouterApiKey = process.env.OPENROUTER_DEFAULT_API_KEY;
  if (openRouterApiKey) {
    return {
      apiKey: openRouterApiKey,
      isConfigured: true,
      provider: 'openrouter',
    };
  }

  return null;
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
    aiLogger.error('Failed to decrypt OpenRouter API key', error instanceof Error ? error : undefined, {
      userId: maskIdentifier(userId),
    });
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
    aiLogger.error('Failed to decrypt Google API key', error instanceof Error ? error : undefined, {
      userId: maskIdentifier(userId),
    });
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
    aiLogger.error('Failed to decrypt OpenAI API key', error instanceof Error ? error : undefined, {
      userId: maskIdentifier(userId),
    });
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
    aiLogger.error('Failed to decrypt Anthropic API key', error instanceof Error ? error : undefined, {
      userId: maskIdentifier(userId),
    });
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
    aiLogger.error('Failed to decrypt xAI API key', error instanceof Error ? error : undefined, {
      userId: maskIdentifier(userId),
    });
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

/**
 * Gets user's Ollama settings
 * Returns baseUrl for use with local Ollama instance
 */
export async function getUserOllamaSettings(userId: string): Promise<{
  baseUrl: string;
  isConfigured: boolean;
} | null> {
  const settings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'ollama')
    ),
  });

  if (!settings || !settings.baseUrl) {
    return null;
  }

  return {
    baseUrl: settings.baseUrl,
    isConfigured: true,
  };
}

/**
 * Creates Ollama provider settings for a user
 * Stores the baseUrl for local Ollama instance connection
 */
export async function createOllamaSettings(
  userId: string,
  baseUrl: string
): Promise<void> {
  // Validate and format the base URL - store user input as-is
  // The system will add /api suffix when needed for specific API calls
  let formattedUrl = baseUrl.trim();

  // Remove trailing slash if present
  formattedUrl = formattedUrl.replace(/\/$/, '');

  const baseUrlSummary = (() => {
    try {
      const parsed = new URL(formattedUrl);
      return {
        origin: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`,
        hasCustomPath: parsed.pathname !== '/',
      };
    } catch {
      return { origin: formattedUrl };
    }
  })();

  aiLogger.debug('Persisting Ollama base URL', {
    userId: maskIdentifier(userId),
    ...baseUrlSummary,
  });

  // Check if settings already exist
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'ollama')
    ),
  });

  if (existingSettings) {
    // Update existing settings
    await db
      .update(userAiSettings)
      .set({
        baseUrl: formattedUrl,
        updatedAt: new Date(),
      })
      .where(eq(userAiSettings.id, existingSettings.id));
  } else {
    // Create new settings
    await db.insert(userAiSettings).values({
      id: createId(),
      userId,
      provider: 'ollama',
      baseUrl: formattedUrl,
      // Note: Ollama doesn't use API keys, so encryptedApiKey is null
    });
  }
}

/**
 * Deletes Ollama provider settings for a user
 * Removes the baseUrl configuration from database
 */
export async function deleteOllamaSettings(userId: string): Promise<void> {
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'ollama')
    ),
  });

  if (existingSettings) {
    await db
      .delete(userAiSettings)
      .where(eq(userAiSettings.id, existingSettings.id));
  }
}

/**
 * Gets user's LM Studio settings
 * Returns baseUrl for use with local LM Studio server instance
 */
export async function getUserLMStudioSettings(userId: string): Promise<{
  baseUrl: string;
  isConfigured: boolean;
} | null> {
  const settings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'lmstudio')
    ),
  });

  if (!settings || !settings.baseUrl) {
    return null;
  }

  return {
    baseUrl: settings.baseUrl,
    isConfigured: true,
  };
}

/**
 * Creates LM Studio provider settings for a user
 * Stores the baseUrl for local LM Studio server connection
 */
export async function createLMStudioSettings(
  userId: string,
  baseUrl: string
): Promise<void> {
  // Validate and format the base URL - store user input as-is
  let formattedUrl = baseUrl.trim();

  // Remove trailing slash if present
  formattedUrl = formattedUrl.replace(/\/$/, '');

  const baseUrlSummary = (() => {
    try {
      const parsed = new URL(formattedUrl);
      return {
        origin: `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`,
        hasCustomPath: parsed.pathname !== '/',
      };
    } catch {
      return { origin: formattedUrl };
    }
  })();

  aiLogger.debug('Persisting LM Studio base URL', {
    userId: maskIdentifier(userId),
    ...baseUrlSummary,
  });

  // Check if settings already exist
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'lmstudio')
    ),
  });

  if (existingSettings) {
    // Update existing settings
    await db
      .update(userAiSettings)
      .set({
        baseUrl: formattedUrl,
        updatedAt: new Date(),
      })
      .where(eq(userAiSettings.id, existingSettings.id));
  } else {
    // Create new settings
    await db.insert(userAiSettings).values({
      id: createId(),
      userId,
      provider: 'lmstudio',
      baseUrl: formattedUrl,
      // Note: LM Studio doesn't use API keys, so encryptedApiKey is null
    });
  }
}

/**
 * Deletes LM Studio provider settings for a user
 * Removes the baseUrl configuration from database
 */
export async function deleteLMStudioSettings(userId: string): Promise<void> {
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'lmstudio')
    ),
  });

  if (existingSettings) {
    await db
      .delete(userAiSettings)
      .where(eq(userAiSettings.id, existingSettings.id));
  }
}

/**
 * Gets user's GLM API settings
 * Returns decrypted API key for use with GLM Coder Plan provider
 */
export async function getUserGLMSettings(userId: string): Promise<{
  apiKey: string;
  isConfigured: boolean;
} | null> {
  const settings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'glm')
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
    aiLogger.error('Failed to decrypt GLM API key', error instanceof Error ? error : undefined, {
      userId: maskIdentifier(userId),
    });
    return null;
  }
}

/**
 * Creates GLM provider settings for a user
 * Encrypts and stores the API key securely
 */
export async function createGLMSettings(
  userId: string,
  apiKey: string
): Promise<void> {
  const { encrypt } = await import('@pagespace/lib/server');
  const encryptedApiKey = await encrypt(apiKey);

  // Check if settings already exist
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'glm')
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
      provider: 'glm',
      encryptedApiKey,
    });
  }
}

/**
 * Deletes GLM provider settings for a user
 * Removes the encrypted API key from database
 */
export async function deleteGLMSettings(userId: string): Promise<void> {
  const existingSettings = await db.query.userAiSettings.findFirst({
    where: and(
      eq(userAiSettings.userId, userId),
      eq(userAiSettings.provider, 'glm')
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