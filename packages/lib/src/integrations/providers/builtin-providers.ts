import type { IntegrationProviderConfig } from '../types';
import { genericWebhookProvider } from './generic-webhook';
import { githubProvider } from './github';
import { notionProvider } from './notion';
import { slackProvider } from './slack';

export const builtinProviders: Record<string, IntegrationProviderConfig> = {
  [genericWebhookProvider.id]: genericWebhookProvider,
  [githubProvider.id]: githubProvider,
  [notionProvider.id]: notionProvider,
  [slackProvider.id]: slackProvider,
};

export const builtinProviderList: IntegrationProviderConfig[] =
  Object.values(builtinProviders);

export const getBuiltinProvider = (
  id: string
): IntegrationProviderConfig | null => builtinProviders[id] ?? null;

export const isBuiltinProvider = (id: string): boolean => id in builtinProviders;

/**
 * The authoritative config for a provider, at any read site.
 *
 * Builtin providers are defined in code and can change shape (new tool ids,
 * renamed bundles) on any deploy. The persisted `integration_providers.config`
 * row is only a cache seeded at install time and refreshed lazily — it can lag
 * behind the in-memory definition until something happens to trigger a refresh.
 * Rather than trust that cache, always prefer the current in-memory definition
 * for a `providerType: 'builtin'` row; custom/openapi/webhook providers keep
 * their persisted config, even if their slug happens to collide with a builtin
 * (rows created before slug reservation existed), so a custom provider is never
 * silently handed a builtin's tools or OAuth metadata.
 */
export const resolveProviderConfig = (
  provider: { slug: string; providerType: string; config: unknown } | null | undefined
): IntegrationProviderConfig | null => {
  if (!provider) return null;
  const persisted = provider.config as IntegrationProviderConfig | null;
  if (provider.providerType !== 'builtin') return persisted;
  return getBuiltinProvider(provider.slug) ?? persisted;
};
