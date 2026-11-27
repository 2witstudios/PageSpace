import { describe, it, expect, vi } from 'vitest';
import { assert } from '@/test/riteway';
import { deliverPdfPage, parsePdfPageRange, PDF_VISUAL_LIMITS, type PdfFilePage } from '../read-page-pdf';
import type { VisualPartsDeliveredOutput } from '../read-page-vision-output';

const HASH = 'b'.repeat(64);
const PDF = Buffer.from('%PDF-1.7\nfake pdf body');
const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]);

const filePage = (overrides: Partial<PdfFilePage> = {}): PdfFilePage => ({
  id: 'page-pdf',
  title: 'Exhibits.pdf',
  contentHash: HASH,
  fileSize: PDF.length,
  originalFileName: 'Exhibits.pdf',
  extractionMetadata: { pageCount: 12, rasterizedPages: 12 },
  ...overrides,
});

/** A fetcher over an in-memory preset map; records every preset asked for. */
const fetcherFor = (presets: Record<string, Buffer>) => {
  const fetchBytes = vi.fn(async (_hash: string, preset: string, options?: { maxBytes?: number }) => {
    const bytes = presets[preset];
    if (!bytes) return null;
    if (options?.maxBytes !== undefined && bytes.length > options.maxBytes) return null;
    return bytes;
  });
  return fetchBytes;
};

const allPages = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`pdf-page-${i + 1}`, jpeg(`p${i + 1}`)]));

const notBlocked = async () => false;

describe('parsePdfPageRange', () => {
  it('parses single pages, ranges and lists into sorted unique page numbers', () => {
    assert({
      given: '"7-9, 2,4,2"',
      should: 'return the sorted unique pages',
      actual: parsePdfPageRange('7-9, 2,4,2'),
      expected: [2, 4, 7, 8, 9],
    });
  });

  for (const bad of ['abc', '0', '5-2', '-3', '1-', '', '1.5']) {
    it(`rejects "${bad}"`, () => {
      const result = parsePdfPageRange(bad);
      expect(Array.isArray(result)).toBe(false);
    });
  }
});

describe('deliverPdfPage — native PDF', () => {
  it('hands a PDF-reading model the whole PDF as one file part', async () => {
    const fetchBytes = fetcherFor({ original: PDF, ...allPages(12) });

    const result = await deliverPdfPage({ page: filePage(), hasPdfInput: true, fetchBytes, isBlocked: notBlocked }) as VisualPartsDeliveredOutput;

    assert({
      given: 'a small PDF and a model with native PDF input',
      should: 'deliver one application/pdf file part with the original bytes',
      actual: { type: result.type, parts: result.parts },
      expected: {
        type: 'visual_parts_delivered',
        parts: [{ kind: 'file', mediaType: 'application/pdf', data: PDF.toString('base64'), filename: 'Exhibits.pdf' }],
      },
    });
    assert({
      given: 'a native PDF fetch',
      should: 'cap the original at the per-PDF limit',
      actual: fetchBytes.mock.calls[0],
      expected: [HASH, 'original', { maxBytes: PDF_VISUAL_LIMITS.maxPdfBytes }],
    });
  });

  it('sends page images instead when the PDF is over the size cap, without fetching it', async () => {
    const fetchBytes = fetcherFor({ original: PDF, ...allPages(12) });

    const result = await deliverPdfPage({
      page: filePage({ fileSize: 72 * 1024 * 1024 }), hasPdfInput: true, fetchBytes, isBlocked: notBlocked,
    }) as VisualPartsDeliveredOutput;

    expect(fetchBytes.mock.calls.map((c) => c[1])).not.toContain('original');
    expect(result.parts.every((p) => p.kind === 'image')).toBe(true);
    expect(result.message).toMatch(/too large/i);
  });

  it('sends page images instead when the PDF has more pages than a provider reads natively', async () => {
    const fetchBytes = fetcherFor({ original: PDF, ...allPages(12) });

    const result = await deliverPdfPage({
      page: filePage({ extractionMetadata: { pageCount: 400, rasterizedPages: 12 } }), hasPdfInput: true, fetchBytes, isBlocked: notBlocked,
    }) as VisualPartsDeliveredOutput;

    expect(result.parts.every((p) => p.kind === 'image')).toBe(true);
  });

  it('sends page images when the original does not look like a PDF', async () => {
    const fetchBytes = fetcherFor({ original: Buffer.from('not a pdf'), ...allPages(12) });

    const result = await deliverPdfPage({ page: filePage(), hasPdfInput: true, fetchBytes, isBlocked: notBlocked }) as VisualPartsDeliveredOutput;

    expect(result.parts.every((p) => p.kind === 'image')).toBe(true);
  });

  it('honours an explicit pages range with page images even on a PDF-reading model', async () => {
    const fetchBytes = fetcherFor({ original: PDF, ...allPages(12) });

    const result = await deliverPdfPage({ page: filePage(), hasPdfInput: true, pages: '3', fetchBytes, isBlocked: notBlocked }) as VisualPartsDeliveredOutput;

    expect(result.parts).toEqual([{ kind: 'image', mediaType: 'image/jpeg', data: jpeg('p3').toString('base64'), pdfPage: 3 }]);
  });
});

describe('deliverPdfPage — page images', () => {
  it('shows the first batch of pages by default and says how to see more', async () => {
    const fetchBytes = fetcherFor(allPages(12));

    const result = await deliverPdfPage({ page: filePage(), hasPdfInput: false, fetchBytes, isBlocked: notBlocked }) as VisualPartsDeliveredOutput;

    assert({
      given: 'a vision-only model and no pages range',
      should: `deliver the first ${PDF_VISUAL_LIMITS.defaultPageBatch} pages, each labelled with its page number`,
      actual: result.parts.map((p) => p.pdfPage),
      expected: [1, 2, 3, 4, 5],
    });
    expect(result.message).toContain('pages: "6-10"');
    expect(result.metadata.nextPages).toBe('6-10');
  });

  it('shows exactly the requested pages', async () => {
    const fetchBytes = fetcherFor(allPages(12));

    const result = await deliverPdfPage({ page: filePage(), hasPdfInput: false, pages: '2,4-5', fetchBytes, isBlocked: notBlocked }) as VisualPartsDeliveredOutput;

    expect(result.parts.map((p) => p.pdfPage)).toEqual([2, 4, 5]);
    expect(fetchBytes.mock.calls.map((c) => c[1]).sort()).toEqual(['pdf-page-2', 'pdf-page-4', 'pdf-page-5']);
  });

  it('fetches page images a few at a time, never more than the concurrency limit at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const presets = allPages(12);
    const fetchBytes = vi.fn(async (_hash: string, preset: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return presets[preset] ?? null;
    });

    const result = await deliverPdfPage({ page: filePage(), hasPdfInput: false, pages: '1-10', fetchBytes, isBlocked: notBlocked }) as VisualPartsDeliveredOutput;

    expect(result.parts.map((p) => p.pdfPage)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(maxInFlight).toBe(PDF_VISUAL_LIMITS.fetchConcurrency);
  });

  it('caps each page image at the per-image size limit', async () => {
    const fetchBytes = fetcherFor(allPages(12));

    await deliverPdfPage({ page: filePage(), hasPdfInput: false, pages: '1', fetchBytes, isBlocked: notBlocked });

    expect(fetchBytes.mock.calls[0][2]).toEqual({ maxBytes: PDF_VISUAL_LIMITS.maxImageBytes });
  });

  it('stops at the total cap across all parts and names where to resume', async () => {
    const fetchBytes = fetcherFor(allPages(12));
    const each = jpeg('p1').length;

    const result = await deliverPdfPage({
      page: filePage(), hasPdfInput: false, pages: '1-5', fetchBytes, isBlocked: notBlocked,
      limits: { maxTotalBytes: each * 2 + 1 },
    }) as VisualPartsDeliveredOutput;

    expect(result.parts.map((p) => p.pdfPage)).toEqual([1, 2]);
    expect(result.metadata.nextPages).toBe('3-7');
    expect(result.message).toMatch(/size limit/i);
  });

  it('limits one read to the maximum pages per call', async () => {
    const fetchBytes = fetcherFor(allPages(40));

    const result = await deliverPdfPage({
      page: filePage({ extractionMetadata: { pageCount: 40, rasterizedPages: 40 } }), hasPdfInput: false, pages: '1-40', fetchBytes, isBlocked: notBlocked,
    }) as VisualPartsDeliveredOutput;

    expect(result.parts).toHaveLength(PDF_VISUAL_LIMITS.maxPagesPerRead);
    expect(result.metadata.nextPages).toBe(`${PDF_VISUAL_LIMITS.maxPagesPerRead + 1}-${PDF_VISUAL_LIMITS.maxPagesPerRead + PDF_VISUAL_LIMITS.defaultPageBatch}`);
  });

  it('clamps a range to the rendered pages and says only those exist as images', async () => {
    const fetchBytes = fetcherFor(allPages(3));

    const result = await deliverPdfPage({
      page: filePage({ extractionMetadata: { pageCount: 90, rasterizedPages: 3 } }), hasPdfInput: false, pages: '2-6', fetchBytes, isBlocked: notBlocked,
    }) as VisualPartsDeliveredOutput;

    expect(result.parts.map((p) => p.pdfPage)).toEqual([2, 3]);
    expect(result.message).toContain('first 3 pages');
  });

  it('refuses a range that is entirely past the rendered pages', async () => {
    const fetchBytes = fetcherFor(allPages(3));

    const result = await deliverPdfPage({
      page: filePage({ extractionMetadata: { pageCount: 90, rasterizedPages: 3 } }), hasPdfInput: false, pages: '10-12', fetchBytes, isBlocked: notBlocked,
    }) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('1-3');
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('refuses a malformed range', async () => {
    const result = await deliverPdfPage({
      page: filePage(), hasPdfInput: false, pages: 'first five', fetchBytes: fetcherFor({}), isBlocked: notBlocked,
    }) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pages/);
  });

  it('skips a page image that fails JPEG validation', async () => {
    const fetchBytes = fetcherFor({ ...allPages(3), 'pdf-page-2': Buffer.from('garbage') });

    const result = await deliverPdfPage({ page: filePage(), hasPdfInput: false, pages: '1-3', fetchBytes, isBlocked: notBlocked }) as VisualPartsDeliveredOutput;

    expect(result.parts.map((p) => p.pdfPage)).toEqual([1, 3]);
  });

  it('stops at the first missing page when the rendered count is unknown', async () => {
    const fetchBytes = fetcherFor(allPages(2));

    const result = await deliverPdfPage({
      page: filePage({ extractionMetadata: null }), hasPdfInput: false, fetchBytes, isBlocked: notBlocked,
    }) as VisualPartsDeliveredOutput;

    expect(result.parts.map((p) => p.pdfPage)).toEqual([1, 2]);
    expect(result.metadata.nextPages).toBeUndefined();
  });
});

describe('deliverPdfPage — text layer', () => {
  it('says a mixed PDF also has text the agent can read with lineStart/lineEnd', async () => {
    const result = await deliverPdfPage({
      page: filePage(), hasPdfInput: false, fetchBytes: fetcherFor(allPages(12)), isBlocked: notBlocked, textLayerChars: 20_000,
    }) as VisualPartsDeliveredOutput;
    expect(result.message).toMatch(/text layer \(20000 characters\).*lineStart/);
  });

  it('says nothing about text when the PDF has none', async () => {
    const result = await deliverPdfPage({
      page: filePage(), hasPdfInput: false, fetchBytes: fetcherFor(allPages(12)), isBlocked: notBlocked,
    }) as VisualPartsDeliveredOutput;
    expect(result.message).not.toMatch(/text layer/);
  });
});

describe('deliverPdfPage — nothing to show', () => {
  it('falls back to metadata that says to reprocess when no page images exist', async () => {
    const result = await deliverPdfPage({
      page: filePage({ extractionMetadata: null }), hasPdfInput: false, fetchBytes: fetcherFor({}), isBlocked: notBlocked,
    }) as { type: string; metadata: { hint: string } };

    expect(result.type).toBe('visual_content_metadata');
    expect(result.metadata.hint).toMatch(/reprocess/i);
  });

  it('reads nothing for a taken-down file', async () => {
    const fetchBytes = fetcherFor({ original: PDF, ...allPages(12) });

    const result = await deliverPdfPage({ page: filePage(), hasPdfInput: true, fetchBytes, isBlocked: async () => true }) as { type: string };

    expect(result.type).toBe('visual_content_metadata');
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('reads nothing when the blocklist cannot be checked', async () => {
    const fetchBytes = fetcherFor({ original: PDF });

    const result = await deliverPdfPage({
      page: filePage(), hasPdfInput: true, fetchBytes, isBlocked: async () => { throw new Error('db down'); },
    }) as { type: string };

    expect(result.type).toBe('visual_content_metadata');
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('treats a fetch failure as "nothing to show" rather than failing the read', async () => {
    const fetchBytes = vi.fn(async () => { throw new Error('processor down'); });

    const result = await deliverPdfPage({ page: filePage(), hasPdfInput: true, fetchBytes, isBlocked: notBlocked }) as { type: string };

    expect(result.type).toBe('visual_content_metadata');
  });
});
