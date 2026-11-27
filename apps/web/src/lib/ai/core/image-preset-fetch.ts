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
import { fetchPresetOrNull, type FetchPresetBytes } from '@/lib/ai/tools/processor-file-fetch';

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
 * blocked: read_page's contract is "the file's bytes, or nothing", and nothing is
 * the safe answer when we cannot tell. Shared by the image and PDF paths.
 */
export async function isContentRemoved(
  contentHash: string,
  isBlocked: (contentHash: string) => Promise<boolean> = isHashBlocked,
): Promise<boolean> {
  try {
    return await isBlocked(contentHash);
  } catch (err) {
    // No content hash in the log: the hash of a possibly-blocked file stays out of logs.
    loggers.ai.warn('read_page: blocklist lookup failed, treating the file as unavailable', {
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

  if (await isContentRemoved(contentHash, deps.isBlocked)) return null;

  for (const candidate of buildFallbackChain(mimeType)) {
    if (!isAllowedImageType(candidate.mediaType)) continue;

    // A fetch failure (permissions, transient outage, malformed key) degrades to
    // "this candidate isn't usable" rather than failing the whole read_page call:
    // the metadata-only result must stay a guaranteed-success fallback.
    const bytes = await fetchPresetOrNull(fetchBytes, contentHash, candidate.preset, { maxBytes: MAX_IMAGE_SIZE_BYTES }, (preset, error) =>
      loggers.ai.warn('fetchCachedImagePreset: candidate fetch failed, skipping', { contentHash, preset, error }));
    if (!bytes) continue;
    // The fetcher caps at the same size; this holds the cap for the "original"
    // fallback (up to the per-tier max file size) whatever fetcher is injected.
    if (bytes.length > MAX_IMAGE_SIZE_BYTES) continue;

    const base64 = bytes.toString('base64');
    if (!validateMagicBytes(base64, candidate.mediaType as AllowedImageType)) continue;

    return { base64, mediaType: candidate.mediaType, preset: candidate.preset };
  }

  return null;
}
