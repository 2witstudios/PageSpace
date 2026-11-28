import { describe, it, expect, vi, beforeEach } from 'vitest';

// Content safety: the rejected-upload delete skips a hash held for a takedown. Nothing is blocked here.
vi.mock('@pagespace/lib/content-safety/blocklist', () => ({ isHashBlocked: vi.fn().mockResolvedValue(false) }));

const mocks = vi.hoisted(() => ({
  getOriginal: vi.fn(),
  deleteOriginal: vi.fn().mockResolvedValue(true),
  saveCache: vi.fn().mockResolvedValue({}),
  setPageProcessing: vi.fn().mockResolvedValue(undefined),
  setPageCompleted: vi.fn().mockResolvedValue(undefined),
  setPageVisual: vi.fn().mockResolvedValue(undefined),
  setPageVisualWithContent: vi.fn().mockResolvedValue(undefined),
  setPageVideoProcessed: vi.fn().mockResolvedValue(undefined),
  setPageFailed: vi.fn().mockResolvedValue(undefined),
  verifyContentHash: vi.fn(),
  detectContentType: vi.fn(),
  isAllowedContentType: vi.fn(),
  extractTextContent: vi.fn(),
  extractPdfContent: vi.fn(),
  rasterizePdfPages: vi.fn(),
  withPdf: vi.fn(),
  pdfPagesPaintingImages: vi.fn(),
  generateImageVariants: vi.fn(),
  extractVideoMetadata: vi.fn(),
  extractVideoThumbnail: vi.fn(),
}));

vi.mock('../../server', () => ({
  contentStore: {
    getOriginal: mocks.getOriginal,
    deleteOriginal: mocks.deleteOriginal,
    saveCache: mocks.saveCache,
  },
}));

vi.mock('../../db', () => ({
  setPageProcessing: mocks.setPageProcessing,
  setPageCompleted: mocks.setPageCompleted,
  setPageVisual: mocks.setPageVisual,
  setPageVisualWithContent: mocks.setPageVisualWithContent,
  setPageVideoProcessed: mocks.setPageVideoProcessed,
  setPageFailed: mocks.setPageFailed,
}));

// The pure PDF helpers (low-text rule, preset naming, page cap) run for real;
// only the byte-processing functions are mocked.
// The loaded document is a stand-in; extraction and rendering are mocked.
const FAKE_PDF = vi.hoisted(() => ({ numPages: 3 }));
vi.mock('../../services/processing-pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/processing-pipeline')>();
  return {
  isScanLikePdf: actual.isScanLikePdf,
  leadingPdfPages: actual.leadingPdfPages,
  pdfPagesPaintingImages: mocks.pdfPagesPaintingImages,
  pdfPagePreset: actual.pdfPagePreset,
  resolveMaxRasterizedPdfPages: actual.resolveMaxRasterizedPdfPages,
  withPdf: mocks.withPdf,
  extractPdfContent: mocks.extractPdfContent,
  rasterizePdfPages: mocks.rasterizePdfPages,
  verifyContentHash: mocks.verifyContentHash,
  detectContentType: mocks.detectContentType,
  isAllowedContentType: mocks.isAllowedContentType,
  extractTextContent: mocks.extractTextContent,
  generateImageVariants: mocks.generateImageVariants,
  extractVideoMetadata: mocks.extractVideoMetadata,
  extractVideoThumbnail: mocks.extractVideoThumbnail,
  };
});

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { processor: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

import { fetchObjectFromS3, runPullPipeline, processPdfPage } from '../s3-pull-adapter';

const HASH = 'c'.repeat(64);
const BYTES = Buffer.from('stored-bytes');
const NO_WAIT = { delayMs: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.deleteOriginal.mockResolvedValue(true);
  mocks.saveCache.mockResolvedValue({});
  mocks.verifyContentHash.mockReturnValue(true);
  mocks.isAllowedContentType.mockReturnValue(true);
  mocks.detectContentType.mockResolvedValue({ label: 'pdf', mimeType: 'application/pdf', score: 0.9, source: 'magika' });
  mocks.extractTextContent.mockResolvedValue('extracted text');
  mocks.withPdf.mockImplementation(async (_bytes: Buffer, work: (pdf: unknown) => Promise<unknown>) => work(FAKE_PDF));
  mocks.extractPdfContent.mockResolvedValue({ text: 'extracted text '.repeat(10), pageCount: 1, lowTextPageNumbers: [] });
  mocks.rasterizePdfPages.mockResolvedValue({ rendered: [] });
  // Every low-text page paints an image unless a test says otherwise.
  mocks.pdfPagesPaintingImages.mockImplementation(async (_pdf: unknown, candidates: number[], limit: number) => candidates.slice(0, limit));
  mocks.generateImageVariants.mockResolvedValue({
    thumbnail: { buffer: Buffer.from('t'), mimeType: 'image/webp' },
    'ai-chat': { buffer: Buffer.from('j'), mimeType: 'image/jpeg' },
  });
  mocks.extractVideoMetadata.mockResolvedValue({ duration: 10, width: 640, height: 480 });
  mocks.extractVideoThumbnail.mockResolvedValue(Buffer.from('thumb'));
});

describe('fetchObjectFromS3', () => {
  it('returns the object bytes when present on the first try', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    const result = await fetchObjectFromS3(HASH, NO_WAIT);
    expect(result).toEqual(BYTES);
    expect(mocks.getOriginal).toHaveBeenCalledTimes(1);
  });

  it('retries up to 3 times when the object is not yet committed', async () => {
    mocks.getOriginal
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(BYTES);
    const result = await fetchObjectFromS3(HASH, NO_WAIT);
    expect(result).toEqual(BYTES);
    expect(mocks.getOriginal).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all retries', async () => {
    mocks.getOriginal.mockResolvedValue(null);
    await expect(fetchObjectFromS3(HASH, NO_WAIT)).rejects.toThrow();
    expect(mocks.getOriginal).toHaveBeenCalledTimes(3);
  });
});

describe('runPullPipeline — zero-trust gates', () => {
  it('deletes the object and fails the job when the stored bytes do not match the hash', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.verifyContentHash.mockReturnValue(false);

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.deleteOriginal).toHaveBeenCalledWith(HASH);
    expect(mocks.setPageFailed).toHaveBeenCalled();
    expect(mocks.setPageCompleted).not.toHaveBeenCalled();
  });

  it('deletes the object and fails the job when the detected type is disallowed', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.detectContentType.mockResolvedValue({ label: 'elf', mimeType: 'application/octet-stream', score: 0.9, source: 'magika' });
    mocks.isAllowedContentType.mockReturnValue(false);

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.deleteOriginal).toHaveBeenCalledWith(HASH);
    expect(mocks.setPageFailed).toHaveBeenCalled();
  });

  it('still marks the page failed when deleting the rejected object throws', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.verifyContentHash.mockReturnValue(false);
    mocks.deleteOriginal.mockRejectedValue(new Error('S3 down'));

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.setPageFailed).toHaveBeenCalled();
  });

  it('does not delete or persist when verification passes and type is allowed', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);
    expect(mocks.deleteOriginal).not.toHaveBeenCalled();
  });
});

describe('runPullPipeline — dispatch by detected type', () => {
  describe('PDFs', () => {
    const page = (n: number) => ({ pageNumber: n, buffer: Buffer.from(`jpeg-${n}`), mimeType: 'image/jpeg' });
    /** Stands in for rendering: hands each listed page to onPage in order, as the real one does. */
    const rendersListed = async (_pdf: unknown, opts: { pages: number[]; onPage: (p: ReturnType<typeof page>) => Promise<void> }) => {
      for (const n of opts.pages) await opts.onPage(page(n));
      return { rendered: opts.pages };
    };
    /** ~2,000 characters per typed page. */
    const typedText = (pages: number) => 'Typed prose of a real text layer. '.repeat(60 * pages);

    beforeEach(() => {
      mocks.getOriginal.mockResolvedValue(BYTES);
      mocks.detectContentType.mockResolvedValue({ label: 'pdf', mimeType: 'application/pdf', score: 0.9, source: 'magika' });
      mocks.rasterizePdfPages.mockImplementation(rendersListed);
    });

    it('marks a text PDF completed with its text and renders nothing when every page has text', async () => {
      await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

      expect(mocks.extractPdfContent).toHaveBeenCalledWith(FAKE_PDF);
      expect(mocks.setPageCompleted).toHaveBeenCalledWith(
        'page-1', 'extracted text '.repeat(10), { mimeType: 'application/pdf', pageCount: 1 }, 'text',
      );
      expect(mocks.rasterizePdfPages).not.toHaveBeenCalled();
      expect(mocks.setPageVisualWithContent).not.toHaveBeenCalled();
    });

    it('keeps a report with blank separator pages completed with its full text, rendering zero pages', async () => {
      const text = typedText(8);
      mocks.extractPdfContent.mockResolvedValue({ text, pageCount: 10, lowTextPageNumbers: [5, 10] });
      mocks.pdfPagesPaintingImages.mockResolvedValue([]);

      await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

      expect(mocks.setPageVisualWithContent).not.toHaveBeenCalled();
      expect(mocks.setPageCompleted).toHaveBeenCalledWith(
        'page-1', text, { mimeType: 'application/pdf', pageCount: 10 }, 'text',
      );
      expect(mocks.pdfPagesPaintingImages).toHaveBeenCalledWith(FAKE_PDF, [5, 10], 50);
      expect(mocks.rasterizePdfPages).not.toHaveBeenCalled();
    });

    it('renders the one low-text page of a text PDF that paints a full-page scanned figure', async () => {
      const text = typedText(9);
      mocks.extractPdfContent.mockResolvedValue({ text, pageCount: 10, lowTextPageNumbers: [3, 10] });
      mocks.pdfPagesPaintingImages.mockResolvedValue([3]);

      await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

      expect(mocks.rasterizePdfPages).toHaveBeenCalledWith(FAKE_PDF, expect.objectContaining({ pages: [3] }));
      expect(mocks.setPageCompleted).toHaveBeenCalledWith(
        'page-1', text, { mimeType: 'application/pdf', pageCount: 10, renderedPages: [3] }, 'text',
      );
    });

    it('keeps a bundle of 10 typed pages and 190 scans completed, rendering its first 50 scans', async () => {
      const text = typedText(10);
      const scans = Array.from({ length: 190 }, (_, i) => i + 11);
      mocks.extractPdfContent.mockResolvedValue({ text, pageCount: 200, lowTextPageNumbers: scans });

      await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

      expect(mocks.setPageCompleted).toHaveBeenCalledWith(
        'page-1', text, { mimeType: 'application/pdf', pageCount: 200, renderedPages: scans.slice(0, 50) }, 'text',
      );
    });

    describe('a scan (no real text layer)', () => {
      beforeEach(() => {
        mocks.extractPdfContent.mockResolvedValue({ text: 'p. 1', pageCount: 3, lowTextPageNumbers: [1, 2, 3] });
      });

      it('marks it visual, keeping its text, with its leading pages rendered', async () => {
        await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

        // A scan renders as before, without an image check per page.
        expect(mocks.pdfPagesPaintingImages).not.toHaveBeenCalled();
        expect(mocks.setPageCompleted).not.toHaveBeenCalled();
        expect(mocks.setPageVisualWithContent).toHaveBeenCalledWith('page-1', 'p. 1', {
          mimeType: 'application/pdf',
          pageCount: 3,
          renderedPages: [1, 2, 3],
        });
      });

      it('caches each rendered page as a pdf-page-{n} JPEG preset, one at a time', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        mocks.saveCache.mockImplementation(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight--;
          return {};
        });

        await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

        expect(mocks.saveCache.mock.calls.map((c) => [c[1], c[3]])).toEqual([
          ['pdf-page-1', 'image/jpeg'],
          ['pdf-page-2', 'image/jpeg'],
          ['pdf-page-3', 'image/jpeg'],
        ]);
        // saveCache read-modify-writes the hash's cache metadata, so parallel saves would race.
        expect(maxInFlight).toBe(1);
      });

      it('renders only the configured number of pages', async () => {
        const previous = process.env.PDF_RASTER_MAX_PAGES;
        process.env.PDF_RASTER_MAX_PAGES = '2';
        try {
          await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);
        } finally {
          if (previous === undefined) delete process.env.PDF_RASTER_MAX_PAGES;
          else process.env.PDF_RASTER_MAX_PAGES = previous;
        }

        expect(mocks.rasterizePdfPages).toHaveBeenCalledWith(FAKE_PDF, expect.objectContaining({ pages: [1, 2] }));
      });

      it('still marks it visual when rendering fails, recording that no pages were rendered', async () => {
        mocks.rasterizePdfPages.mockRejectedValue(new Error('canvas unavailable'));

        await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

        expect(mocks.setPageFailed).not.toHaveBeenCalled();
        expect(mocks.setPageVisualWithContent).toHaveBeenCalledWith('page-1', 'p. 1', expect.objectContaining({ renderedPages: [] }));
      });

      it('records no rendered pages when caching them fails', async () => {
        mocks.saveCache.mockRejectedValue(new Error('S3 down'));

        await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

        expect(mocks.setPageVisualWithContent).toHaveBeenCalledWith('page-1', 'p. 1', expect.objectContaining({ renderedPages: [] }));
      });
    });

    it('loads and parses one PDF at a time across the upload and reprocess queues', async () => {
      mocks.extractPdfContent.mockResolvedValue({ text: 'p. 1', pageCount: 3, lowTextPageNumbers: [1, 2, 3] });
      let open = 0;
      let peak = 0;
      mocks.withPdf.mockImplementation(async (_bytes: Buffer, work: (pdf: unknown) => Promise<unknown>) => {
        open++;
        peak = Math.max(peak, open);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await work(FAKE_PDF);
        } finally {
          open--;
        }
      });

      // pull-verify (an upload) and ingest-file (a reprocess) both land here.
      await Promise.all([
        processPdfPage('page-1', HASH, BYTES),
        processPdfPage('page-2', HASH, BYTES),
        processPdfPage('page-3', HASH, BYTES),
      ]);

      expect(mocks.withPdf).toHaveBeenCalledTimes(3);
      // A waiting PDF holds no parsed document: the load happens inside the limit.
      expect(peak).toBe(1);
    });
  });

  it('generates image variants and marks the page visual for an image', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.detectContentType.mockResolvedValue({ label: 'png', mimeType: 'image/png', score: 0.9, source: 'magika' });

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.generateImageVariants).toHaveBeenCalledWith(BYTES);
    // each variant must be cached with its own MIME type, not a hardcoded one
    expect(mocks.saveCache).toHaveBeenCalledWith(HASH, 'thumbnail', expect.anything(), 'image/webp');
    expect(mocks.saveCache).toHaveBeenCalledWith(HASH, 'ai-chat', expect.anything(), 'image/jpeg');
    expect(mocks.setPageVisual).toHaveBeenCalledWith('page-1');
  });

  it('extracts metadata + thumbnail and records video processing for a video', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.detectContentType.mockResolvedValue({ label: 'mp4', mimeType: 'video/mp4', score: 0.9, source: 'magika' });

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.extractVideoMetadata).toHaveBeenCalledWith(BYTES);
    expect(mocks.extractVideoThumbnail).toHaveBeenCalledWith(BYTES);
    expect(mocks.setPageVideoProcessed).toHaveBeenCalled();
  });

  it('falls back to visual for an allowed but unsupported type', async () => {
    mocks.getOriginal.mockResolvedValue(BYTES);
    mocks.detectContentType.mockResolvedValue({ label: 'bin', mimeType: 'application/octet-stream', score: 0.9, source: 'magika' });

    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);

    expect(mocks.setPageVisual).toHaveBeenCalledWith('page-1');
    expect(mocks.setPageCompleted).not.toHaveBeenCalled();
  });

  it('marks the page failed when the object can never be fetched', async () => {
    mocks.getOriginal.mockResolvedValue(null);
    await runPullPipeline({ pageId: 'page-1', contentHash: HASH }, NO_WAIT);
    expect(mocks.setPageFailed).toHaveBeenCalled();
  });
});
