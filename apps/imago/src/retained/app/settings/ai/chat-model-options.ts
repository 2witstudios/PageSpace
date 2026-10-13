import {
  ADMIN_ONLY_PROVIDERS,
  AI_PROVIDERS,
  isModelAllowedForTier,
} from '@/retained/lib/ai/core/ai-providers-config';

export interface ProviderAvailabilityStatus {
  readonly isAvailable: boolean;
}

export interface ChatModelOption {
  /** The select's value: unambiguous even when a model id contains punctuation. */
  readonly value: string;
  readonly provider: string;
  readonly model: string;
  /** "Provider · Model", as the board shows it. */
  readonly label: string;
}

/** Local providers' catalogs are discovered at runtime; each maps model id to display name. */
export type DynamicModels = Readonly<Record<string, Readonly<Record<string, string>>>>;

export const chatModelValue = (provider: string, model: string): string => JSON.stringify([provider, model]);

/**
 * The chat-model choices this user can make on this deployment: every available provider's
 * models, limited to the user's tier (cloud catalogue) and to admins for admin-only providers.
 * Local providers list the models the server reported, not the static catalogue.
 */
export function buildChatModelOptions({
  providers,
  tier,
  isAdmin,
  dynamicModels,
}: {
  readonly providers: Readonly<Record<string, ProviderAvailabilityStatus>>;
  readonly tier: string | undefined;
  readonly isAdmin: boolean;
  readonly dynamicModels: DynamicModels;
}): ChatModelOption[] {
  return Object.entries(providers).flatMap(([provider, status]) => {
    if (!status.isAvailable) return [];
    if (ADMIN_ONLY_PROVIDERS.has(provider) && !isAdmin) return [];

    const config = AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS];
    const providerName = config?.name ?? provider;
    const dynamic = dynamicModels[provider];
    const models: [string, string][] = dynamic
      ? Object.entries(dynamic)
      : config
        ? Object.entries(config.models).filter(([model]) => isModelAllowedForTier(model, tier))
        : [];

    return models.map(([model, displayName]) => ({
      value: chatModelValue(provider, model),
      provider,
      model,
      label: `${providerName} · ${displayName}`,
    }));
  });
}
