/**
 * Shared on-prem user bootstrap defaults.
 *
 * Both the admin user-create API route and the setup-onprem-admin CLI script
 * need identical defaults when provisioning users in on-prem mode.  Keeping
 * them here avoids policy drift.
 */

/** Fields to spread into a `users` insert/update for on-prem deployments. */
export function getOnPremUserDefaults() {
  return {
    subscriptionTier: 'business' as const,
    currentAiProvider: 'ollama',
    currentAiModel: '',
  };
}

/** Fields for the default Ollama `userAiSettings` row. */
export function getOnPremOllamaSettings() {
  return {
    provider: 'ollama' as const,
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  };
}
