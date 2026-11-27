import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import {
  withPdf,
  extractPdfContent,
  isScanLikePdf,
  leadingPdfPages,
  pdfPagesPaintingImages,
  rasterizePdfPages,
  pdfPagePreset,
  resolveMaxRasterizedPdfPages,
  DEFAULT_MAX_RASTERIZED_PDF_PAGES,
  type RasterizedPdfPage,
} from '../processing-pipeline';

/**
 * Builds a real, well-formed PDF whose pages each carry the given content
 * stream, so pdfjs parses and renders it for real. A page stream of
 * `0 0 1 rg 100 100 200 200 re f` paints a blue square; a text stream uses the
 * standard Helvetica font.
 */
function buildPdf(pageStreams: string[], mediaBox = '0 0 612 792'): Buffer {
  const objects: string[] = [];
  objects.push('<</Type/Catalog/Pages 2 0 R>>');
  const firstPageObj = 4;
  const kids = pageStreams.map((_, i) => `${firstPageObj + i * 2} 0 R`).join(' ');
  objects.push(`<</Type/Pages/Kids[${kids}]/Count ${pageStreams.length}>>`);
  objects.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  pageStreams.forEach((stream, i) => {
    objects.push(`<</Type/Page/Parent 2 0 R/MediaBox[${mediaBox}]/Resources<</Font<</F1 3 0 R>>>>/Contents ${firstPageObj + i * 2 + 1} 0 R>>`);
    objects.push(`<</Length ${stream.length}>>stream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj${body}endobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'binary');
}

const BLUE_SQUARE = '0 0 1 rg 100 100 200 200 re f';
/** A full-page scanned figure: a (tiny, 2x2 greyscale) inline image scaled to the page. */
const FULL_PAGE_SCAN = 'q 612 0 0 792 0 0 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x10\x80\x80\x10 EI Q';
const text = (s: string) => `BT /F1 12 Tf 72 700 Td (${s}) Tj ET`;
/** A page of typed lines, one per 14pt, from the top margin down. */
const textLines = (lines: string[]) => `BT /F1 11 Tf 14 TL 72 740 Td ${lines.map((l) => `(${l}) '`).join(' ')} ET`;

describe('extractPdfContent', () => {
  it('returns the extracted text and the page count', async () => {
    const pdf = buildPdf([text('Exhibit one has real words'), BLUE_SQUARE, BLUE_SQUARE]);

    const result = await withPdf(pdf, extractPdfContent);

    expect(result.pageCount).toBe(3);
    expect(result.text).toContain('Exhibit one has real words');
  });
});

describe('extractPdfContent — low-text pages', () => {
  it('lists each page whose text layer is under the per-page threshold', async () => {
    const pdf = buildPdf([text('This index page lists every exhibit in the bundle.'), BLUE_SQUARE, text('p. 3')]);

    const { lowTextPageNumbers, pageCount } = await withPdf(pdf, extractPdfContent);

    expect(pageCount).toBe(3);
    expect(lowTextPageNumbers).toEqual([2, 3]);
  });
});

describe('isScanLikePdf', () => {
  it('is true for a scan with no text at all', () => {
    expect(isScanLikePdf({ text: '', pageCount: 12 })).toBe(true);
  });

  it('is true when the only text is page numbers or stamps', () => {
    expect(isScanLikePdf({ text: '1 2 3 4 5 6 7 8 9 10', pageCount: 10 })).toBe(true);
  });

  it('is false once the document has a real text layer, however many pages are images', () => {
    const indexPages = 'x'.repeat(2_000).repeat(10);
    expect(isScanLikePdf({ text: indexPages, pageCount: 200 })).toBe(false);
  });

  it('ignores whitespace when counting', () => {
    expect(isScanLikePdf({ text: ' \n\t '.repeat(500), pageCount: 1 })).toBe(true);
  });
});

describe('leadingPdfPages', () => {
  it("lists a scan's leading pages, up to the cap", () => {
    expect(leadingPdfPages(80, 50)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(leadingPdfPages(3, 50)).toEqual([1, 2, 3]);
  });
});

describe('pdfPagesPaintingImages', () => {
  const prose = (n: number) => text(`Section ${n}: the quarterly figures and the commentary that explains them.`);

  it('finds no images on blank separator pages', async () => {
    const blank = text('This page intentionally left blank');
    const pdf = buildPdf([prose(1), blank, prose(2), blank, text('')]);

    expect(await withPdf(pdf, (doc) => pdfPagesPaintingImages(doc, [2, 4, 5], 50))).toEqual([]);
  });

  it('finds no images on a cover with only text or a vector drawing', async () => {
    const pdf = buildPdf([text('ANNUAL REPORT'), BLUE_SQUARE]);

    expect(await withPdf(pdf, (doc) => pdfPagesPaintingImages(doc, [1, 2], 50))).toEqual([]);
  });

  it('finds a page that paints a full-page scanned figure', async () => {
    const pdf = buildPdf([prose(1), prose(2), FULL_PAGE_SCAN, prose(3)]);

    expect(await withPdf(pdf, (doc) => pdfPagesPaintingImages(doc, [3], 50))).toEqual([3]);
  });

  it('stops once it has found the most pages it may render', async () => {
    const pdf = buildPdf([FULL_PAGE_SCAN, FULL_PAGE_SCAN, FULL_PAGE_SCAN]);

    expect(await withPdf(pdf, (doc) => pdfPagesPaintingImages(doc, [1, 2, 3], 2))).toEqual([1, 2]);
  });
});

describe('real PDFs', () => {
  it('a 10-page report with 2 "intentionally left blank" pages is a text document', async () => {
    const prose = (n: number) => text(`Section ${n}: the quarterly figures and the commentary that explains them.`);
    const blank = text('This page intentionally left blank');
    const pdf = buildPdf([prose(1), prose(2), prose(3), prose(4), blank, prose(5), prose(6), prose(7), prose(8), blank]);

    const content = await withPdf(pdf, extractPdfContent);

    expect(content.lowTextPageNumbers).toEqual([5, 10]);
    expect(isScanLikePdf(content)).toBe(false);
    expect(content.text).toContain('Section 8:');
    // Its blank pages paint nothing, so it renders zero pages.
    expect(await withPdf(pdf, (doc) => pdfPagesPaintingImages(doc, content.lowTextPageNumbers, 50))).toEqual([]);
  }, 30000);

  it('a 200-page bundle (10 typed index pages, 190 scans) is a text document whose scans get rendered', async () => {
    // Typed index pages carry ~2,000 characters each, as in the incident's bundle.
    const typed = Array.from({ length: 10 }, (_, i) => textLines(
      Array.from({ length: 40 }, (_, line) => `Index entry ${i + 1}.${line + 1}: exhibit source and date received`),
    ));
    const pdf = buildPdf([...typed, ...Array.from({ length: 190 }, () => FULL_PAGE_SCAN)]);

    const { content, imagePages } = await withPdf(pdf, async (doc) => {
      const extracted = await extractPdfContent(doc);
      return { content: extracted, imagePages: await pdfPagesPaintingImages(doc, extracted.lowTextPageNumbers, 50) };
    });

    expect(content.lowTextPageNumbers).toEqual(Array.from({ length: 190 }, (_, i) => i + 11));
    expect(isScanLikePdf(content)).toBe(false);
    expect(imagePages).toEqual(Array.from({ length: 50 }, (_, i) => i + 11));
    expect(content.text).toContain('Index entry 10.40:');
  }, 60000);

  it('a scan with no text is scan-like', async () => {
    const pdf = buildPdf([BLUE_SQUARE, BLUE_SQUARE, text('3')]);
    expect(isScanLikePdf(await withPdf(pdf, extractPdfContent))).toBe(true);
  }, 30000);
});

/** Render through the real loader, collecting what onPage receives. */
async function render(pdf: Buffer, pageNumbers: number[]) {
  const pages: RasterizedPdfPage[] = [];
  const result = await withPdf(pdf, (doc) => rasterizePdfPages(doc, { pages: pageNumbers, onPage: async (page) => { pages.push(page); } }));
  return { pages, ...result };
}

describe('rasterizePdfPages', () => {
  it('renders each page as a JPEG within the 2048px ai-vision budget', async () => {
    const pdf = buildPdf([BLUE_SQUARE, BLUE_SQUARE]);

    const { pages, rendered } = await render(pdf, [1, 2]);

    expect(rendered).toEqual([1, 2]);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2]);
    for (const page of pages) {
      expect(page.mimeType).toBe('image/jpeg');
      const meta = await sharp(page.buffer).metadata();
      expect(meta.format).toBe('jpeg');
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2048);
      // Rendered at the budget, not at 72 dpi: the long side uses it.
      expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeGreaterThan(1500);
    }
  }, 30000);

  it('keeps a very wide page within the budget on its long side', async () => {
    const pdf = buildPdf([BLUE_SQUARE], '0 0 3000 400');

    const { pages } = await render(pdf, [1]);

    const meta = await sharp(pages[0].buffer).metadata();
    expect(meta.width).toBeLessThanOrEqual(2048);
    expect(meta.height).toBeLessThanOrEqual(2048);
  }, 30000);

  it('paints the page content onto a white background', async () => {
    const pdf = buildPdf([BLUE_SQUARE]);

    const { pages } = await render(pdf, [1]);

    const { data, info } = await sharp(pages[0].buffer).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    // Top-left corner: blank page area → white, not transparent-black.
    const [r0, g0, b0] = pixel(5, 5);
    expect(Math.min(r0, g0, b0)).toBeGreaterThan(240);
    // The square sits at 100-300pt from the bottom-left; sample its centre.
    const scale = info.width / 612;
    const [r, g, b] = pixel(Math.round(200 * scale), Math.round((792 - 200) * scale));
    expect(b).toBeGreaterThan(200);
    expect(r).toBeLessThan(60);
    expect(g).toBeLessThan(60);
  }, 30000);

  it('renders text set in a standard font', async () => {
    const pdf = buildPdf(['BT /F1 48 Tf 72 600 Td (EXHIBIT 4) Tj ET']);

    const { pages } = await render(pdf, [1]);

    const { data, info } = await sharp(pages[0].buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
    const dark = data.filter((v) => v < 100).length;
    // The words leave ink on the page; without font data they render as nothing.
    expect(dark / (info.width * info.height)).toBeGreaterThan(0.001);
  }, 30000);

  it('stops when handing a page on fails', async () => {
    const pdf = buildPdf([BLUE_SQUARE, BLUE_SQUARE]);
    const onPage = vi.fn(async () => { throw new Error('S3 down'); });

    await expect(withPdf(pdf, (doc) => rasterizePdfPages(doc, { pages: [1, 2], onPage }))).rejects.toThrow('S3 down');
    expect(onPage).toHaveBeenCalledTimes(1);
  }, 30000);

  it('lets the event loop run between pages', async () => {
    const pdf = buildPdf([BLUE_SQUARE, BLUE_SQUARE]);
    let ranBetweenPages = false;
    let ranBeforePage2 = false;

    await withPdf(pdf, async (doc) => {
      // Observe the moment page 2 is asked for: right after page 1 was handed on,
      // before pdf.js does any work of its own for page 2.
      const getPage = doc.getPage.bind(doc);
      (doc as { getPage: typeof doc.getPage }).getPage = (n: number) => {
        if (n === 2) ranBeforePage2 = ranBetweenPages;
        return getPage(n);
      };
      await rasterizePdfPages(doc, {
        pages: [1, 2],
        onPage: async (page) => {
          if (page.pageNumber === 1) setImmediate(() => { ranBetweenPages = true; });
        },
      });
    });

    expect(ranBeforePage2).toBe(true);
  }, 30000);

  it('renders only the listed pages, skipping any past the end', async () => {
    const pdf = buildPdf([BLUE_SQUARE, BLUE_SQUARE, BLUE_SQUARE, BLUE_SQUARE]);

    const { pages, rendered } = await render(pdf, [2, 4, 9]);

    expect(rendered).toEqual([2, 4]);
    expect(pages.map((p) => p.pageNumber)).toEqual([2, 4]);
  }, 30000);
});

describe('pdf page presets', () => {
  it('names the preset for a page', () => {
    expect(pdfPagePreset(7)).toBe('pdf-page-7');
  });

  it('reads the page cap from the environment, falling back to the default', () => {
    expect(resolveMaxRasterizedPdfPages({})).toBe(DEFAULT_MAX_RASTERIZED_PDF_PAGES);
    expect(resolveMaxRasterizedPdfPages({ PDF_RASTER_MAX_PAGES: '12' })).toBe(12);
    expect(resolveMaxRasterizedPdfPages({ PDF_RASTER_MAX_PAGES: 'nope' })).toBe(DEFAULT_MAX_RASTERIZED_PDF_PAGES);
    expect(resolveMaxRasterizedPdfPages({ PDF_RASTER_MAX_PAGES: '0' })).toBe(DEFAULT_MAX_RASTERIZED_PDF_PAGES);
  });
});
