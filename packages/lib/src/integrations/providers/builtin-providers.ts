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
 * The authoritative config for a provider, at any read site: for a
 * `providerType: 'builtin'` row, prefer the current in-memory definition over
 * the persisted `integration_providers.config` cache, which only refreshes
 * lazily and can lag behind after a deploy. Every other providerType keeps its
 * own persisted config unconditionally — including a row whose slug happens
 * to collide with a builtin — so a custom provider is never silently handed a
 * builtin's tools or OAuth metadata. The returned object may be the shared
 * in-memory builtin definition itself; treat it as read-only.
 */
export const resolveProviderConfig = (
  provider: { slug: string; providerType: string; config: unknown } | null | undefined
): IntegrationProviderConfig | null => {
  if (!provider) return null;
  const persisted = provider.config as IntegrationProviderConfig | null;
  if (provider.providerType !== 'builtin') return persisted;
  return getBuiltinProvider(provider.slug) ?? persisted;
};

/**
 * Immutably overlay the resolved config onto a provider row. Returns the row
 * unchanged (same reference) when resolution is a no-op — e.g. custom
 * providers — so list paths don't clone rows for nothing. Shared by the
 * repository read paths so connection reads and grant reads can never drift.
 */
export const withResolvedConfig = <
  P extends { slug: string; providerType: string; config: unknown },
>(
  provider: P
): P => {
  const resolved = resolveProviderConfig(provider);
  return resolved === provider.config ? provider : { ...provider, config: resolved };
};
