/**
 * Fetches a cached image preset (produced by the processor's image pipeline) for a
 * FILE page's contentHash, preferring higher-quality vision-oriented presets and
 * falling back down to the original upload when no cache entry is usable.
 *
 * The byte fetch is injected. read_page passes the processor-backed fetcher
 * (`processorCacheFetcherForPage`), which reads through the processor's
 * `/cache/:hash/:preset` route so encrypted-at-rest bytes come back decrypted
 * and the file authorization is re-checked there. Reading S3 directly returned
 * ciphertext whenever FILE_ENCRYPTION_ENABLED was on, and the image silently
 * failed validation.
 */
import { isAllowedImageType, validateMagicBytes, type AllowedImageType } from '@/lib/validation/image-validation';
import { MAX_IMAGE_SIZE_BYTES } from '@/lib/ai/shared/utils/image-resize';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { isHashBlocked } from '@pagespace/lib/content-safety/blocklist';
import type { FetchPresetBytes } from '@/lib/ai/tools/processor-file-fetch';

export interface FetchedImagePreset {
  base64: string;
  mediaType: string;
  preset: string;
}

export interface FetchCachedImagePresetDeps {
  fetchBytes: FetchPresetBytes;
  /** Whether the hash is on the content blocklist. Injectable like `fetchBytes`. */
  isBlocked?: (contentHash: string) => Promise<boolean>;
}

/**
 * A taken-down file is never read or sent to a model provider — including while
 * its takedown is still waiting to delete the bytes. A failed lookup counts as
 * blocked: this function's contract is "an image, or nothing", and nothing is
 * the safe answer when we cannot tell.
 */
async function isRemoved(contentHash: string, isBlocked: (contentHash: string) => Promise<boolean>): Promise<boolean> {
  try {
    return await isBlocked(contentHash);
  } catch (err) {
    // No content hash in the log: this function is given nothing else that
    // identifies the file, and the hash of a possibly-blocked file stays out of logs.
    loggers.ai.warn('fetchCachedImagePreset: blocklist lookup failed, treating the image as unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Preset fallback chain: the processor always re-encodes ai-vision/ai-chat presets as
 * jpeg (see apps/processor/src/types/index.ts IMAGE_PRESETS), regardless of the
 * original upload's format — only the final "original" fallback is validated against
 * the page's own declared mimeType.
 */
function buildFallbackChain(mimeType: string): Array<{ preset: string; mediaType: string }> {
  return [
    { preset: 'ai-vision', mediaType: 'image/jpeg' },
    { preset: 'ai-chat', mediaType: 'image/jpeg' },
    { preset: 'original', mediaType: mimeType },
  ];
}

export async function fetchCachedImagePreset(
  contentHash: string,
  mimeType: string,
  deps: FetchCachedImagePresetDeps,
): Promise<FetchedImagePreset | null> {
  const { fetchBytes } = deps;

  if (await isRemoved(contentHash, deps.isBlocked ?? isHashBlocked)) return null;

  for (const candidate of buildFallbackChain(mimeType)) {
    if (!isAllowedImageType(candidate.mediaType)) continue;

    let bytes: Buffer | null;
    try {
      bytes = await fetchBytes(contentHash, candidate.preset, { maxBytes: MAX_IMAGE_SIZE_BYTES });
    } catch (err) {
      // A fetch failure (permissions, transient outage, malformed key) degrades to
      // "this candidate isn't usable" rather than failing the whole read_page call —
      // the pre-existing metadata-only behavior must remain a guaranteed-success
      // fallback regardless of which fetchBytes implementation is in use.
      loggers.ai.warn('fetchCachedImagePreset: candidate fetch failed, skipping', {
        contentHash,
        preset: candidate.preset,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!bytes) continue;
    // The ai-vision/ai-chat presets are already resized well under this cap; this
    // matters for the uncapped "original" fallback, which can otherwise be an
    // arbitrarily large upload (up to the per-tier max file size).
    if (bytes.length > MAX_IMAGE_SIZE_BYTES) continue;

    const base64 = bytes.toString('base64');
    if (!validateMagicBytes(base64, candidate.mediaType as AllowedImageType)) continue;

    return { base64, mediaType: candidate.mediaType, preset: candidate.preset };
  }

  return null;
}
