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
