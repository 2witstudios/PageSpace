/**
 * The publisher-facing notice for files the publish gate held back. Neutral on
 * purpose: it never says why (blocked, flagged, unscanned or a failed copy), so
 * it tells an abuser nothing about which bytes tripped which check. Pure; safe
 * for client components.
 */

export const HELD_ASSETS_MESSAGE = "Some files couldn't be published";
export const HELD_ASSETS_DESCRIPTION = "They won't show on the published page. Try publishing again later.";

/** How many files a publish response says were held. Tolerates any response shape. */
export function heldAssetCount(response: unknown): number {
  if (!response || typeof response !== 'object' || !('heldAssets' in response)) return 0;
  const held = (response as { heldAssets?: unknown }).heldAssets;
  return Array.isArray(held) ? held.length : 0;
}
