/**
 * Fetches a cached image preset (produced by the processor's image pipeline) for a
 * FILE page's contentHash, preferring higher-quality vision-oriented presets and
 * falling back down to the original upload when no cache entry is usable.
 *
 * The byte fetch is injectable so callers (and tests) can swap the S3/Tigris boundary
 * without mocking the AWS SDK — the default reuses the same client/bucket/key scheme
 * already used for presigned thumbnail URLs (`@/lib/presigned-url`).
 */
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client, getS3Bucket } from '@/lib/presigned-url';
import { isAllowedImageType, validateMagicBytes, type AllowedImageType } from '@/lib/validation/image-validation';
import { MAX_IMAGE_SIZE_BYTES } from '@/lib/ai/shared/utils/image-resize';
import { loggers } from '@pagespace/lib/logging/logger-config';

export interface FetchedImagePreset {
  base64: string;
  mediaType: string;
  preset: string;
}

export interface FetchCachedImagePresetDeps {
  fetchBytes?: (contentHash: string, preset: string) => Promise<Buffer | null>;
}

async function defaultFetchBytes(contentHash: string, preset: string): Promise<Buffer | null> {
  const key = preset === 'original' ? `files/${contentHash}/original` : `cache/${contentHash}/${preset}`;
  try {
    const response = await getS3Client().send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }));
    if (!response.Body) return null;
    return Buffer.from(await response.Body.transformToByteArray());
  } catch (err) {
    const isNotFound = err && typeof err === 'object' && ('$metadata' in err
      ? (err as { $metadata: { httpStatusCode?: number } }).$metadata.httpStatusCode === 404
      : (err as { name?: string }).name === 'NoSuchKey');
    if (isNotFound) return null;
    throw err;
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
  deps: FetchCachedImagePresetDeps = {},
): Promise<FetchedImagePreset | null> {
  const fetchBytes = deps.fetchBytes ?? defaultFetchBytes;

  for (const candidate of buildFallbackChain(mimeType)) {
    if (!isAllowedImageType(candidate.mediaType)) continue;

    let bytes: Buffer | null;
    try {
      bytes = await fetchBytes(contentHash, candidate.preset);
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
