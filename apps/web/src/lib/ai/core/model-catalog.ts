/**
 * Server-only model-catalog payload builder.
 *
 * Single source for the model list returned by the public `/api/ai/models`
 * endpoint AND the `list_models` agent tool, so both stay in lockstep.
 *
 * SERVER-ONLY: imports `MODEL_CONTEXT_WINDOWS` from `@pagespace/lib/monitoring/ai-monitoring`,
 * which transitively pulls in the DB client. Import this module only from server
 * code (route handlers, tool `execute`). It is deliberately NOT re-exported from
 * `core/index.ts` so it can never leak into the client bundle.
 */
import { MODEL_CONTEXT_WINDOWS } from '@pagespace/lib/monitoring/ai-monitoring';
import { getVisibleProviders, FREE_TIER_MODELS, isDynamicModelProvider } from './ai-providers-config';

export interface CatalogModel {
  /** Full OpenRouter model id, e.g. "openai/gpt-5.3-chat". The value to store as an agent's aiModel. */
  id: string;
  /** Human-friendly display name from the catalog. */
  displayName: string;
  /** Provider key this model belongs to, e.g. "openai". */
  provider: string;
  /** True if the model is selectable on the free subscription tier. */
  free: boolean;
  /** Context window size in tokens, when known. */
  contextWindow?: number;
}

export interface CatalogProvider {
  /** Provider key, e.g. "openai", "anthropic", "ollama". */
  provider: string;
  /** Display name, e.g. "OpenAI". */
  name: string;
  /** True when models are discovered at runtime (local/Azure) — `models` is empty here. */
  dynamic: boolean;
  models: CatalogModel[];
}

/**
 * Build the model catalog grouped by provider, filtered to the providers visible
 * in the current deployment mode. No pricing is included by design.
 */
export function buildModelCatalog(): CatalogProvider[] {
  const visible = getVisibleProviders();
  return Object.entries(visible).map(([provider, cfg]) => ({
    provider,
    name: cfg!.name,
    dynamic: isDynamicModelProvider(provider),
    models: Object.entries(cfg!.models).map(([id, displayName]) => ({
      id,
      displayName: displayName as string,
      provider,
      free: FREE_TIER_MODELS.has(id),
      contextWindow: MODEL_CONTEXT_WINDOWS[id as keyof typeof MODEL_CONTEXT_WINDOWS],
    })),
  }));
}
