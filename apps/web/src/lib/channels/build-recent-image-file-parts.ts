import { isAllowedImageType } from '@/lib/validation/image-validation';
import { MAX_FILE_PARTS_PER_MESSAGE, MAX_DATA_URL_LENGTH } from '@/lib/ai/core/validate-image-parts';

/**
 * Same single-message caps enforced in validate-image-parts.ts (5 images,
 * 4MB each) so a mentioned agent never receives more visual context per
 * consultation than a human would attach to one chat message.
 */
export const MAX_RECENT_IMAGE_ATTACHMENTS = MAX_FILE_PARTS_PER_MESSAGE;
export const MAX_RECENT_IMAGE_ATTACHMENT_SIZE_BYTES = MAX_DATA_URL_LENGTH;

export interface RecentImageFileCandidate {
  fileId: string;
  url: string;
  mimeType: string | null;
  filename: string;
  sizeBytes: number;
  accessible: boolean;
}

export interface ImageFilePart {
  type: 'file';
  url: string;
  mediaType: string;
  filename: string;
}

/**
 * Pure filter/cap over pre-resolved image attachment candidates. Callers are
 * responsible for the side effects (S3 presigned URL generation, DB-backed
 * access checks) before invoking this — it makes no I/O of its own.
 *
 * `candidates` is expected oldest-to-newest; the most recent `maxCount`
 * valid candidates are kept, in their original relative order.
 */
export function buildRecentImageFileParts(
  candidates: RecentImageFileCandidate[],
  maxCount: number = MAX_RECENT_IMAGE_ATTACHMENTS
): ImageFilePart[] {
  const valid = candidates.filter(
    (candidate) =>
      candidate.accessible &&
      candidate.mimeType !== null &&
      isAllowedImageType(candidate.mimeType) &&
      candidate.sizeBytes <= MAX_RECENT_IMAGE_ATTACHMENT_SIZE_BYTES
  );

  return valid.slice(-maxCount).map((candidate) => ({
    type: 'file' as const,
    url: candidate.url,
    mediaType: candidate.mimeType as string,
    filename: candidate.filename,
  }));
}
