/**
 * Pure access/validation helpers for image generation. No I/O — safe to import from
 * routes and tools alike (keeps the Pro+ gate and model validation in one tested place).
 */

/** Image generation requires a paid (Pro+) tier — free/unknown is denied. */
export function isImageGenerationAllowedForTier(tier: string | undefined | null): boolean {
  return tier === 'pro' || tier === 'founder' || tier === 'business';
}

/** A chosen image model id must be one of the currently available OpenRouter image models. */
export function isValidImageModel(modelId: string, available: ReadonlyArray<{ id: string }>): boolean {
  return available.some((m) => m.id === modelId);
}

/**
 * Pure: should the generate_image tool be exposed on this request? True only when the
 * composer toggle is on, a paid tier (or admin) is present, and the tool exists in the
 * baseline set. Mirrors the web_search runtime override but adds the Pro+ gate.
 */
export function shouldExposeImageGen(params: {
  imageGenEnabled: boolean;
  tier: string | undefined | null;
  isAdmin: boolean;
  hasToolDef: boolean;
}): boolean {
  if (!params.imageGenEnabled || !params.hasToolDef) return false;
  return params.isAdmin || isImageGenerationAllowedForTier(params.tier);
}
