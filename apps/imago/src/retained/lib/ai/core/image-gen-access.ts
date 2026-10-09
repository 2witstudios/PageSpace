/**
 * Pure access/validation helpers for image generation. No I/O — safe to import from
 * routes and tools alike (keeps the access gate and model validation in one tested place).
 *
 * ROLLOUT GATE: image generation is currently restricted to APP ADMINS only, so the
 * feature can be verified end-to-end (including correct metering) in production before
 * it is broadened to paid tiers. When broadening, relax `isImageGenerationAllowed`.
 */

/** Image generation is currently allowed for app admins only (rollout safety). */
export function isImageGenerationAllowed(isAdmin: boolean): boolean {
  return isAdmin === true;
}

/** A chosen image model id must be one of the currently available OpenRouter image models. */
export function isValidImageModel(modelId: string, available: ReadonlyArray<{ id: string }>): boolean {
  return available.some((m) => m.id === modelId);
}

/**
 * Pure: should the generate_image tool be exposed on this request? True only when the
 * composer toggle is on, the caller is an app admin, and the tool exists in the baseline
 * set. Mirrors the web_search runtime override but adds the admin-only rollout gate.
 */
export function shouldExposeImageGen(params: {
  imageGenEnabled: boolean;
  isAdmin: boolean;
  hasToolDef: boolean;
}): boolean {
  if (!params.imageGenEnabled || !params.hasToolDef) return false;
  return isImageGenerationAllowed(params.isAdmin);
}
