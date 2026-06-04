/**
 * Default AI provider/model, shared across apps so seed data (admin onboarding)
 * and the web model catalog never drift. Every cloud model is OpenRouter-backed;
 * the default is OpenAI's GPT-5.3 Chat (a member of the free-tier allowlist).
 */
export const DEFAULT_AI_PROVIDER = 'openai';
export const DEFAULT_AI_MODEL = 'openai/gpt-5.3-chat';
