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
 * for a slug that matches a builtin; only custom/openapi/mcp/webhook providers,
 * which have no in-memory definition, fall back to their persisted config.
 */
export const resolveProviderConfig = (
  provider: { slug: string; config: unknown } | null | undefined
): IntegrationProviderConfig | null =>
  provider
    ? getBuiltinProvider(provider.slug) ?? (provider.config as IntegrationProviderConfig | null)
    : null;
