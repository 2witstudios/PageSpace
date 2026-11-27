/**
 * How read_page shows a visual PDF to a vision model.
 *
 * - A model that reads PDFs natively (`hasPdfInput`) gets the whole PDF as one
 *   `application/pdf` file part, when it is small enough to send and short enough
 *   for providers to read.
 * - Otherwise, or when the agent asks for specific `pages`, it gets the
 *   processor's rasterized page images (`pdf-page-{n}` JPEG presets), a batch at a
 *   time, so a long scan can be paged through.
 *
 * Every part has its own size cap, and the parts of one result share a total cap,
 * because a delivered result is re-sent with the conversation on later steps.
 */
import { isHashBlocked } from '@pagespace/lib/content-safety/blocklist';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateMagicBytes } from '@/lib/validation/image-validation';
import { MAX_IMAGE_SIZE_BYTES } from '@/lib/ai/shared/utils/image-resize';
import type { FetchPresetBytes } from './processor-file-fetch';
import {
  buildVisualContentMetadata,
  type DeliveredVisualPart,
  type VisualPartsDeliveredOutput,
} from './read-page-vision-output';

const MiB = 1024 * 1024;

export const PDF_VISUAL_LIMITS = {
  /** Largest PDF sent whole. Base64 grows it by a third, and provider requests cap at ~32 MB. */
  maxPdfBytes: 10 * MiB,
  /** Most pages sent as a whole PDF; providers refuse longer documents (Claude reads up to 100). */
  maxNativePdfPages: 100,
  /** Largest single page image (the same cap as any other image read_page delivers). */
  maxImageBytes: MAX_IMAGE_SIZE_BYTES,
  /** Largest total across every part of one read_page result. */
  maxTotalBytes: 12 * MiB,
  /** Pages shown when the agent names no range. */
  defaultPageBatch: 5,
  /** Most page images in one read_page result. */
  maxPagesPerRead: 20,
};

export type PdfVisualLimits = typeof PDF_VISUAL_LIMITS;

export interface PdfFilePage {
  id: string;
  title: string;
  contentHash: string;
  fileSize: number | null;
  originalFileName: string | null;
  /** pages.extractionMetadata; the processor records `pageCount` and `rasterizedPages` on PDFs. */
  extractionMetadata: unknown;
}

const PAGE_TOKEN = /^(\d+)(?:-(\d+))?$/;

/**
 * Parses a 1-based page selection such as "3", "1-5" or "2,4,7-9" into sorted,
 * unique page numbers. Returns an error string for anything else.
 */
export function parsePdfPageRange(spec: string): number[] | { error: string } {
  const tokens = spec.split(',').map((t) => t.trim());
  const pages = new Set<number>();
  for (const token of tokens) {
    const match = PAGE_TOKEN.exec(token);
    if (!match) return { error: `"${spec}" is not a page range. Use forms like "3", "1-5" or "2,4,7-9".` };
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (start < 1 || end < start) return { error: `"${token}" is not a valid page range: pages start at 1 and a range runs low to high.` };
    // The per-read cap trims later; this bound only keeps a huge range from looping.
    for (let n = start; n <= Math.min(end, start + 10_000); n++) pages.add(n);
  }
  return [...pages].sort((a, b) => a - b);
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function readPdfLayout(extractionMetadata: unknown): { pageCount: number | null; rasterizedPages: number | null } {
  if (typeof extractionMetadata !== 'object' || extractionMetadata === null) {
    return { pageCount: null, rasterizedPages: null };
  }
  const meta = extractionMetadata as Record<string, unknown>;
  const rasterized = meta.rasterizedPages;
  return {
    pageCount: positiveInt(meta.pageCount),
    // 0 is meaningful: the processor ran and rendered nothing.
    rasterizedPages: typeof rasterized === 'number' && Number.isInteger(rasterized) && rasterized >= 0 ? rasterized : null,
  };
}

/** "1-3, 5, 7-8" for [1,2,3,5,7,8]. */
function describePages(pages: number[]): string {
  const runs: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    runs.push(i === j ? `${pages[i]}` : `${pages[i]}-${pages[j]}`);
    i = j + 1;
  }
  return runs.join(', ');
}

async function isRemoved(contentHash: string, isBlocked: (hash: string) => Promise<boolean>): Promise<boolean> {
  try {
    return await isBlocked(contentHash);
  } catch (err) {
    // A failed lookup counts as blocked: nothing is the safe answer when we cannot tell.
    loggers.ai.warn('read_page PDF: blocklist lookup failed, treating the file as unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

async function tryFetch(fetchBytes: FetchPresetBytes, contentHash: string, preset: string, maxBytes: number): Promise<Buffer | null> {
  try {
    return await fetchBytes(contentHash, preset, { maxBytes });
  } catch (err) {
    // A fetch failure (denied, processor down) means "this part is not available",
    // never a failed read_page call: the metadata fallback must stay reachable.
    loggers.ai.warn('read_page PDF: preset fetch failed, skipping', {
      preset,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function fallback(page: PdfFilePage, hint: string): Record<string, unknown> {
  return buildVisualContentMetadata({
    pageId: page.id,
    title: page.title,
    mimeType: 'application/pdf',
    sizeBytes: page.fileSize ?? 0,
    metadata: { processingStatus: 'visual', originalFileName: page.originalFileName, hint },
  });
}

function delivered(
  page: PdfFilePage,
  message: string,
  parts: DeliveredVisualPart[],
  metadata: Record<string, unknown>,
): VisualPartsDeliveredOutput {
  return {
    success: true,
    type: 'visual_parts_delivered',
    pageId: page.id,
    title: page.title,
    originalMimeType: 'application/pdf',
    message,
    parts,
    sizeBytes: page.fileSize ?? 0,
    metadata: { processingStatus: 'visual', originalFileName: page.originalFileName, ...metadata },
  };
}

export interface DeliverPdfPageParams {
  page: PdfFilePage;
  /** The model reads PDFs natively. The caller has already established it has vision. */
  hasPdfInput: boolean;
  /** The agent's `pages` selection, if any. */
  pages?: string;
  fetchBytes: FetchPresetBytes;
  isBlocked?: (contentHash: string) => Promise<boolean>;
  limits?: Partial<PdfVisualLimits>;
}

export async function deliverPdfPage(params: DeliverPdfPageParams): Promise<VisualPartsDeliveredOutput | Record<string, unknown>> {
  const { page, hasPdfInput, pages, fetchBytes } = params;
  const limits: PdfVisualLimits = { ...PDF_VISUAL_LIMITS, ...params.limits };
  const { pageCount, rasterizedPages } = readPdfLayout(page.extractionMetadata);

  // Validate the range before reading anything.
  let requested: number[] | null = null;
  if (pages !== undefined) {
    const parsed = parsePdfPageRange(pages);
    if (!Array.isArray(parsed)) {
      return { success: false, error: `Invalid pages: ${parsed.error}`, pageId: page.id, title: page.title };
    }
    requested = parsed;
  }

  if (await isRemoved(page.contentHash, params.isBlocked ?? isHashBlocked)) {
    return fallback(page, 'This file is not available.');
  }

  // 1. The whole PDF, for a model that reads PDFs, when no pages were asked for.
  let notSentWhole: string | null = null;
  if (hasPdfInput && requested === null) {
    if (page.fileSize !== null && page.fileSize > limits.maxPdfBytes) {
      notSentWhole = `The PDF is too large to send whole (${(page.fileSize / MiB).toFixed(1)} MB; the limit is ${limits.maxPdfBytes / MiB} MB), so its pages are shown as images.`;
    } else if (pageCount !== null && pageCount > limits.maxNativePdfPages) {
      notSentWhole = `The PDF has ${pageCount} pages, more than a model reads in one PDF (${limits.maxNativePdfPages}), so its pages are shown as images.`;
    } else {
      const bytes = await tryFetch(fetchBytes, page.contentHash, 'original', limits.maxPdfBytes);
      if (bytes && bytes.subarray(0, 5).toString('latin1') === '%PDF-' && bytes.length <= limits.maxTotalBytes) {
        const filename = page.originalFileName ?? `${page.title}.pdf`;
        return delivered(
          page,
          `Delivered "${page.title}" as a PDF${pageCount ? ` (${pageCount} pages)` : ''}.`,
          [{ kind: 'file', mediaType: 'application/pdf', data: bytes.toString('base64'), filename }],
          { delivery: 'pdf', pageCount },
        );
      }
      notSentWhole = 'The PDF could not be sent whole, so its pages are shown as images.';
    }
  }

  // 2. Rasterized page images.
  const batch = requested ?? Array.from({ length: limits.defaultPageBatch }, (_, i) => i + 1);
  let wanted = rasterizedPages === null ? batch : batch.filter((n) => n <= rasterizedPages);
  if (requested !== null && wanted.length === 0) {
    const available = rasterizedPages ? `pages 1-${rasterizedPages}` : 'no pages';
    return {
      success: false,
      error: `None of the requested pages are available as images: this PDF has ${available} rendered${pageCount ? ` of ${pageCount}` : ''}.`,
      pageId: page.id,
      title: page.title,
    };
  }
  let trimmedToPerRead = false;
  if (wanted.length > limits.maxPagesPerRead) {
    wanted = wanted.slice(0, limits.maxPagesPerRead);
    trimmedToPerRead = true;
  }

  const parts: DeliveredVisualPart[] = [];
  let total = 0;
  let stoppedAt: number | null = null;
  let hitTotalCap = false;
  for (const n of wanted) {
    const bytes = await tryFetch(fetchBytes, page.contentHash, `pdf-page-${n}`, limits.maxImageBytes);
    if (!bytes) {
      // With no rendered count, a missing page is the end of what was rendered.
      if (rasterizedPages === null) break;
      continue;
    }
    const base64 = bytes.toString('base64');
    if (!validateMagicBytes(base64, 'image/jpeg')) continue;
    if (total + bytes.length > limits.maxTotalBytes) {
      stoppedAt = n;
      hitTotalCap = true;
      break;
    }
    total += bytes.length;
    parts.push({ kind: 'image', mediaType: 'image/jpeg', data: base64, pdfPage: n });
  }

  if (parts.length === 0) {
    const hint = rasterizedPages === null
      ? 'No page images exist for this PDF yet (it was processed before page images were rendered). Ask the user to reprocess the file, then read it again.'
      : 'No page images could be loaded for this PDF.';
    return fallback(page, notSentWhole ? `${notSentWhole} ${hint}` : hint);
  }

  const shown = parts.map((p) => p.pdfPage as number);
  const lastShown = shown[shown.length - 1];
  const resumeFrom = stoppedAt ?? (trimmedToPerRead ? wanted[wanted.length - 1] + 1 : lastShown + 1);
  // Point at the next batch when this read was cut short, or was the default
  // first batch of a longer document. An explicit range that fit is complete.
  const cutShort = hitTotalCap || trimmedToPerRead || requested === null;
  const nextPages = cutShort && rasterizedPages !== null && resumeFrom <= rasterizedPages
    ? `${resumeFrom}-${Math.min(resumeFrom + limits.defaultPageBatch - 1, rasterizedPages)}`
    : null;

  const sentences = [
    `Showing page${shown.length === 1 ? '' : 's'} ${describePages(shown)}${pageCount ? ` of ${pageCount}` : ''} from "${page.title}" as images.`,
  ];
  if (notSentWhole) sentences.unshift(notSentWhole);
  if (hitTotalCap) sentences.push('Stopped at the size limit for one result.');
  if (nextPages) sentences.push(`Call read_page again with pages: "${nextPages}" to see more.`);
  if (rasterizedPages !== null && pageCount !== null && rasterizedPages < pageCount) {
    sentences.push(`Only the first ${rasterizedPages} pages are available as images.`);
  }

  return delivered(page, sentences.join(' '), parts, {
    delivery: 'page-images',
    pageCount,
    rasterizedPages,
    pagesShown: shown,
    ...(nextPages ? { nextPages } : {}),
  });
}
