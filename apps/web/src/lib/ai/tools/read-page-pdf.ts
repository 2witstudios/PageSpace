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
import { loggers } from '@pagespace/lib/logging/logger-config';
import { MAX_IMAGE_SIZE_BYTES } from '@/lib/ai/shared/utils/image-resize';
import { isContentRemoved } from '@/lib/ai/core/image-preset-fetch';
import { fetchPresetOrNull, type FetchPresetBytes } from './processor-file-fetch';
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
  /** Page images fetched at once. Bounded so a read never holds many over-cap pages. */
  fetchConcurrency: 4,
};

export type PdfVisualLimits = typeof PDF_VISUAL_LIMITS;

export interface PdfFilePage {
  id: string;
  title: string;
  contentHash: string;
  fileSize: number | null;
  originalFileName: string | null;
  /** pages.extractionMetadata; the processor records `pageCount` and `renderedPages` on PDFs. */
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

/**
 * The pages of a PDF that have `pdf-page-{n}` images, from its extractionMetadata,
 * in order: a scan's leading pages, or a text document's low-text pages. Null
 * when the processor recorded none (a PDF processed before page images existed).
 * An empty list is meaningful: processed, nothing rendered.
 */
export function readRenderedPages(extractionMetadata: unknown): number[] | null {
  if (typeof extractionMetadata !== 'object' || extractionMetadata === null) return null;
  const listed = (extractionMetadata as Record<string, unknown>).renderedPages;
  if (!Array.isArray(listed)) return null;
  return listed.filter((n): n is number => positiveInt(n) !== null).sort((a, b) => a - b);
}

function readPdfLayout(extractionMetadata: unknown): { pageCount: number | null; renderedPages: number[] | null } {
  const meta = typeof extractionMetadata === 'object' && extractionMetadata !== null
    ? extractionMetadata as Record<string, unknown>
    : {};
  return { pageCount: positiveInt(meta.pageCount), renderedPages: readRenderedPages(extractionMetadata) };
}

/** "1-3, 5, 7-8" for [1,2,3,5,7,8]; read back by parsePdfPageRange. */
export function describePdfPages(pages: number[]): string {
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

/** A fetch that falls back to "not available" (null), logged. */
function fetchPreset(fetchBytes: FetchPresetBytes, contentHash: string, preset: string, maxBytes: number): Promise<Buffer | null> {
  return fetchPresetOrNull(fetchBytes, contentHash, preset, { maxBytes }, (failedPreset, error) =>
    loggers.ai.warn('read_page PDF: preset fetch failed, skipping', { preset: failedPreset, error }));
}

const isPdfBytes = (bytes: Buffer) => bytes.subarray(0, 5).toString('latin1') === '%PDF-';
const isJpegBytes = (bytes: Buffer) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** The fields every PDF result carries, delivered or not. */
function envelope(page: PdfFilePage) {
  return {
    pageId: page.id,
    title: page.title,
    sizeBytes: page.fileSize ?? 0,
    metadata: { processingStatus: 'visual', originalFileName: page.originalFileName },
  };
}

function fallback(page: PdfFilePage, hint: string): Record<string, unknown> {
  const base = envelope(page);
  return buildVisualContentMetadata({ ...base, mimeType: 'application/pdf', metadata: { ...base.metadata, hint } });
}

function delivered(
  page: PdfFilePage,
  message: string,
  parts: DeliveredVisualPart[],
  metadata: Record<string, unknown>,
): VisualPartsDeliveredOutput {
  const base = envelope(page);
  return {
    ...base,
    success: true,
    type: 'visual_parts_delivered',
    originalMimeType: 'application/pdf',
    message,
    parts,
    metadata: { ...base.metadata, ...metadata },
  };
}

export interface DeliverPdfPageParams {
  page: PdfFilePage;
  /** The model reads PDFs natively. The caller has already established it has vision. */
  hasPdfInput: boolean;
  /** The agent's `pages` selection, if any. */
  pages?: string;
  fetchBytes: FetchPresetBytes;
  /** Characters in the PDF's extracted text layer; above 0, the result says how to read it. */
  textLayerChars?: number;
  isBlocked?: (contentHash: string) => Promise<boolean>;
  limits?: Partial<PdfVisualLimits>;
}

export async function deliverPdfPage(params: DeliverPdfPageParams): Promise<VisualPartsDeliveredOutput | Record<string, unknown>> {
  const { page, hasPdfInput, pages, fetchBytes } = params;
  const limits: PdfVisualLimits = { ...PDF_VISUAL_LIMITS, ...params.limits };
  const textLayerNote = params.textLayerChars
    ? `This PDF also has a text layer (${params.textLayerChars} characters): call read_page with lineStart/lineEnd to read it as text.`
    : null;
  const { pageCount, renderedPages } = readPdfLayout(page.extractionMetadata);
  const rendered = renderedPages === null ? null : new Set(renderedPages);

  // Validate the range before reading anything.
  let requested: number[] | null = null;
  if (pages !== undefined) {
    const parsed = parsePdfPageRange(pages);
    if (!Array.isArray(parsed)) {
      return { success: false, error: `Invalid pages: ${parsed.error}`, pageId: page.id, title: page.title };
    }
    requested = parsed;
  }

  if (await isContentRemoved(page.contentHash, params.isBlocked)) {
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
      const bytes = await fetchPreset(fetchBytes, page.contentHash, 'original', limits.maxPdfBytes);
      if (bytes && isPdfBytes(bytes) && bytes.length <= limits.maxTotalBytes) {
        const filename = page.originalFileName ?? `${page.title}.pdf`;
        return delivered(
          page,
          [`Delivered "${page.title}" as a PDF${pageCount ? ` (${pageCount} pages)` : ''}.`, textLayerNote].filter(Boolean).join(' '),
          [{ kind: 'file', mediaType: 'application/pdf', data: bytes.toString('base64'), filename }],
          { delivery: 'pdf', pageCount },
        );
      }
      notSentWhole = 'The PDF could not be sent whole, so its pages are shown as images.';
    }
  }

  // 2. Rendered page images.
  const batch = requested
    ?? (renderedPages ?? Array.from({ length: limits.defaultPageBatch }, (_, i) => i + 1)).slice(0, limits.defaultPageBatch);
  const available = rendered === null ? batch : batch.filter((n) => rendered.has(n));
  if (requested !== null && available.length === 0) {
    const which = renderedPages?.length ? `pages ${describePdfPages(renderedPages)}` : 'no pages';
    return {
      success: false,
      error: `None of the requested pages are available as images: this PDF has ${which} rendered${pageCount ? ` of ${pageCount}` : ''}.`,
      pageId: page.id,
      title: page.title,
    };
  }
  const wanted = available.slice(0, limits.maxPagesPerRead);

  const parts: DeliveredVisualPart[] = [];
  let total = 0;
  // The first page not shown because this result hit its total size cap.
  let stoppedAt: number | null = null;
  let reachedEnd = false;
  // Fetched a few at a time, then taken strictly in page order.
  for (let i = 0; i < wanted.length && stoppedAt === null && !reachedEnd; i += limits.fetchConcurrency) {
    const chunk = wanted.slice(i, i + limits.fetchConcurrency);
    const fetched = await Promise.all(chunk.map((n) => fetchPreset(fetchBytes, page.contentHash, `pdf-page-${n}`, limits.maxImageBytes)));
    for (let j = 0; j < chunk.length; j++) {
      const n = chunk[j];
      const bytes = fetched[j];
      if (!bytes) {
        // With no rendered list, a missing page is the end of what was rendered.
        if (rendered === null) { reachedEnd = true; break; }
        continue;
      }
      if (!isJpegBytes(bytes)) continue;
      if (total + bytes.length > limits.maxTotalBytes) {
        stoppedAt = n;
        break;
      }
      total += bytes.length;
      parts.push({ kind: 'image', mediaType: 'image/jpeg', data: bytes.toString('base64'), pdfPage: n });
    }
  }

  if (parts.length === 0) {
    const hint = renderedPages === null
      ? 'No page images exist for this PDF yet (it was processed before page images were rendered). Ask the user to reprocess the file, then read it again.'
      : 'No page images could be loaded for this PDF.';
    return fallback(page, notSentWhole ? `${notSentWhole} ${hint}` : hint);
  }

  const shown = parts.map((p) => p.pdfPage as number);
  const lastShown = shown[shown.length - 1];
  const trimmedToPerRead = available.length > wanted.length;
  const resumeFrom = stoppedAt ?? (trimmedToPerRead ? wanted[wanted.length - 1] + 1 : lastShown + 1);
  // Point at the next batch when this read was cut short, or was the default
  // first batch of a longer document. An explicit range that fit is complete.
  const cutShort = stoppedAt !== null || trimmedToPerRead || requested === null;
  const following = cutShort && renderedPages !== null
    ? renderedPages.filter((n) => n >= resumeFrom).slice(0, limits.defaultPageBatch)
    : [];
  const nextPages = following.length > 0 ? describePdfPages(following) : null;

  const sentences = [
    `Showing page${shown.length === 1 ? '' : 's'} ${describePdfPages(shown)}${pageCount ? ` of ${pageCount}` : ''} from "${page.title}" as images.`,
  ];
  if (notSentWhole) sentences.unshift(notSentWhole);
  if (stoppedAt !== null) sentences.push('Stopped at the size limit for one result.');
  if (nextPages) sentences.push(`Call read_page again with pages: "${nextPages}" to see more.`);
  if (renderedPages !== null && pageCount !== null && renderedPages.length < pageCount) {
    sentences.push(`Page images exist for pages ${describePdfPages(renderedPages)} of ${pageCount}.`);
  }
  if (textLayerNote) sentences.push(textLayerNote);

  return delivered(page, sentences.join(' '), parts, {
    delivery: 'page-images',
    pageCount,
    renderedPages,
    pagesShown: shown,
    ...(nextPages ? { nextPages } : {}),
  });
}
