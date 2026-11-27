import { deleteOriginalUnlessHeld } from '../services/takedown-guard';
import { contentStore } from '../server';
import {
  setPageProcessing,
  setPageCompleted,
  setPageVisual,
  setPageVisualWithContent,
  setPageVideoProcessed,
  setPageFailed,
} from '../db';
import {
  verifyContentHash,
  detectContentType,
  isAllowedContentType,
  extractTextContent,
  withPdf,
  extractPdfContent,
  isLowTextPdf,
  rasterizePdfPages,
  pdfPagePreset,
  resolveMaxRasterizedPdfPages,
  generateImageVariants,
  extractVideoMetadata,
  extractVideoThumbnail,
} from '../services/processing-pipeline';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createSemaphore, positiveIntOr } from '../utils/semaphore';

/**
 * S3 pull adapter — the only layer that performs I/O. It fetches the stored
 * object, runs the pure pipeline, and handles rejection/deletion. No processing
 * logic lives here; transformation is delegated to processing-pipeline.
 */

export interface PullJob {
  pageId: string;
  contentHash: string;
}

interface FetchOptions {
  maxAttempts?: number;
  delayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fetch the object bytes, retrying on a not-yet-committed object. The object may
 * not be readable the instant the job fires (read-after-write lag), so retry up
 * to 3 times with a 1s backoff before giving up.
 */
export async function fetchObjectFromS3(contentHash: string, opts: FetchOptions = {}): Promise<Buffer> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const delayMs = opts.delayMs ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const bytes = await contentStore.getOriginal(contentHash);
    if (bytes) return bytes;
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  throw new Error(`Object not found in S3 after ${maxAttempts} attempts: ${contentHash}`);
}

// PDFs are processed on their own (processPdfPage): a scan is visual, not text.
const TEXT_EXTRACTABLE = new Set([
  // .docx only — mammoth cannot read legacy binary .doc (application/msword)
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

export async function runPullPipeline(job: PullJob, fetchOpts: FetchOptions = {}): Promise<void> {
  const { pageId, contentHash } = job;

  let bytes: Buffer;
  try {
    await setPageProcessing(pageId);
    bytes = await fetchObjectFromS3(contentHash, fetchOpts);
  } catch (err) {
    loggers.processor.error('S3 pull failed', err instanceof Error ? err : undefined, { pageId, contentHash });
    await setPageFailed(pageId, err instanceof Error ? err.message : 'Failed to fetch object');
    return;
  }

  // Zero-trust: the stored bytes must hash to the declared content hash.
  if (!verifyContentHash(bytes, contentHash)) {
    loggers.processor.warn('Content hash mismatch — deleting object', { pageId, contentHash });
    await rejectAndFail(pageId, contentHash, 'Stored content does not match the declared hash');
    return;
  }

  // Zero-trust: Magika on the actual bytes overrides the declared MIME type.
  const detected = await detectContentType(bytes);
  if (!isAllowedContentType(detected)) {
    loggers.processor.warn('Disallowed content type — deleting object', { pageId, contentHash, label: detected.label });
    await rejectAndFail(pageId, contentHash, `Disallowed content type: ${detected.label}`);
    return;
  }

  try {
    await dispatch(pageId, contentHash, bytes, detected.mimeType);
  } catch (err) {
    loggers.processor.error('Processing failed', err instanceof Error ? err : undefined, { pageId, contentHash });
    await setPageFailed(pageId, err instanceof Error ? err.message : 'Processing failed');
  }
}

/**
 * Delete the rejected object and mark the page failed. The delete is best-effort
 * — a storage error must not prevent the page from being marked failed, or a
 * rejected upload would linger in 'processing' forever.
 */
async function rejectAndFail(pageId: string, contentHash: string, reason: string): Promise<void> {
  try {
    await deleteOriginalUnlessHeld(contentHash);
  } catch (err) {
    loggers.processor.error('Failed to delete rejected object', err instanceof Error ? err : undefined, { pageId, contentHash });
  }
  await setPageFailed(pageId, reason);
}

async function dispatch(pageId: string, contentHash: string, bytes: Buffer, mimeType: string): Promise<void> {
  if (mimeType.startsWith('image/')) {
    const variants = await generateImageVariants(bytes);
    await Promise.all(
      Object.entries(variants).map(([preset, variant]) =>
        contentStore.saveCache(contentHash, preset, variant.buffer, variant.mimeType),
      ),
    );
    await setPageVisual(pageId);
    return;
  }

  if (mimeType.startsWith('video/')) {
    const [metadata, thumbnail] = await Promise.all([
      extractVideoMetadata(bytes),
      extractVideoThumbnail(bytes),
    ]);
    await contentStore.saveCache(contentHash, 'thumbnail.webp', thumbnail, 'image/webp');
    await setPageVideoProcessed(pageId, { ...metadata, thumbnailKey: `cache/${contentHash}/thumbnail.webp` });
    return;
  }

  if (mimeType === 'application/pdf') {
    await processPdfPage(pageId, contentHash, bytes);
    return;
  }

  if (TEXT_EXTRACTABLE.has(mimeType)) {
    const text = await extractTextContent(bytes, mimeType);
    await setPageCompleted(pageId, text ?? '', { mimeType }, 'text');
    return;
  }

  // Allowed but not specifically processable — keep the file, mark visual.
  await setPageVisual(pageId);
}

/**
 * Rendering a scan is the heaviest thing the processor does (hundreds of MB off
 * heap, near-second event-loop stalls per page on a shared CPU), and both the
 * upload queue (pull-verify) and Reprocess (ingest-file) reach processPdfPage.
 * One process-wide limit keeps two scans from rendering at once.
 */
const pdfRendering = createSemaphore(positiveIntOr(process.env.PDF_RASTER_CONCURRENCY, 1));

/**
 * A PDF with a real text layer is read as text. A PDF with almost none — a scan —
 * is marked `visual` (keeping whatever text it had, for search and for text-only
 * models) and its leading pages are rendered to `pdf-page-{n}` JPEG presets, so a
 * vision model can look at it. Marking a scan `completed` with empty content left
 * agents nothing to read and never reached the visual path.
 *
 * Shared by the upload pipeline and the ingest-file worker (Reprocess), so a
 * reprocessed scan gets the same status and page images as a new upload.
 * Returns the status it recorded.
 */
export async function processPdfPage(pageId: string, contentHash: string, bytes: Buffer): Promise<'completed' | 'visual'> {
  const mimeType = 'application/pdf';
  return withPdf(bytes, async (pdf) => {
    const { text, pageCount } = await extractPdfContent(pdf);

    if (!isLowTextPdf(text, pageCount)) {
      await setPageCompleted(pageId, text, { mimeType, pageCount }, 'text');
      return 'completed';
    }

    let rasterizedPages = 0;
    try {
      const { rendered, attempted } = await pdfRendering.run(() => rasterizePdfPages(pdf, {
        maxPages: resolveMaxRasterizedPdfPages(),
        // Each page is cached as soon as it is rendered, and one at a time:
        // saveCache read-modify-writes the hash's cache metadata.
        onPage: async (page) => {
          await contentStore.saveCache(contentHash, pdfPagePreset(page.pageNumber), page.buffer, page.mimeType);
        },
      }));
      rasterizedPages = rendered > 0 ? attempted : 0;
    } catch (err) {
      // The page stays readable (as a PDF, or by its text) without page images.
      loggers.processor.warn('PDF page rendering failed; marking visual without page images', {
        pageId,
        contentHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await setPageVisualWithContent(pageId, text, { mimeType, pageCount, rasterizedPages });
    return 'visual';
  });
}
