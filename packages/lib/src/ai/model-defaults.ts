/**
 * Default AI provider/model, shared across apps so seed data (admin onboarding)
 * and the web model catalog never drift. Every cloud model is OpenRouter-backed;
 * the default is OpenAI's GPT-5.3 Codex (a member of the free-tier allowlist).
 */
export const DEFAULT_AI_PROVIDER = 'openai';
export const DEFAULT_AI_MODEL = 'openai/gpt-5.3-codex';

/**
 * Providers whose usage is logged for observability but never billed against the
 * shared credit pool. The admin-only `glm` provider routes directly to the Z.ai
 * Coder Plan endpoint — a flat-rate external subscription — so its spend must not
 * draw down OpenRouter credits. The credit gate is skipped (no hold placed) and
 * `consumeCredits` is bypassed at settle for these providers.
 *
 * Note: this is the *backend* provider id. The public, OpenRouter-backed Z.ai
 * provider (`zai`, model ids `z-ai/*`) is metered normally and is NOT in this set.
 */
export const METERING_EXEMPT_PROVIDERS = new Set<string>(['glm']);

/** Whether a provider's usage is exempt from credit billing (see {@link METERING_EXEMPT_PROVIDERS}). */
export function isMeteringExempt(provider: string | null | undefined): boolean {
  return !!provider && METERING_EXEMPT_PROVIDERS.has(provider);
}
