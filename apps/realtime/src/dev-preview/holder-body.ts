/**
 * The body every signed web→realtime dev-preview call carries: a HOLDER, and
 * nothing else that is trusted. Which sprite the holder is on is re-derived
 * from the holder's own row on this side (`resolveHolderSandboxId`), so a
 * signed-but-wrong sprite name can never be watched or read. One parser for
 * the two routes (`/api/dev-preview/watch`, `/api/dev-preview/listeners`) so
 * they cannot drift on what "well-formed" means.
 */

import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';

/** Pure: the holder named by a signed body, or null for anything malformed. */
export function readDevPreviewHolderBody(body: string): DevPreviewHolderRef | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const holder = (parsed as { holder?: unknown }).holder;
  if (typeof holder !== 'object' || holder === null) return null;
  const { kind, id } = holder as { kind?: unknown; id?: unknown };
  if ((kind !== 'workspace' && kind !== 'env') || typeof id !== 'string' || id.length === 0) return null;
  return { kind, id };
}
