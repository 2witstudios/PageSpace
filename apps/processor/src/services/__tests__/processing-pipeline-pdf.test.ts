import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import {
  withPdf,
  extractPdfContent,
  isLowTextPdf,
  rasterizePdfPages,
  pdfPagePreset,
  resolveMaxRasterizedPdfPages,
  LOW_TEXT_CHARS_PER_PAGE,
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
const text = (s: string) => `BT /F1 12 Tf 72 700 Td (${s}) Tj ET`;

describe('extractPdfContent', () => {
  it('returns the extracted text and the page count', async () => {
    const pdf = buildPdf([text('Exhibit one has real words'), BLUE_SQUARE, BLUE_SQUARE]);

    const result = await withPdf(pdf, extractPdfContent);

    expect(result.pageCount).toBe(3);
    expect(result.text).toContain('Exhibit one has real words');
  });
});

describe('isLowTextPdf', () => {
  it('is true for a scan with no text', () => {
    expect(isLowTextPdf('', 12)).toBe(true);
  });

  it('is true when only a few characters per page exist (page numbers, stamps)', () => {
    expect(isLowTextPdf('1 2 3 4 5 6 7 8 9 10', 10)).toBe(true);
  });

  it('is false once the text reaches the per-page threshold', () => {
    const perPage = 'x'.repeat(LOW_TEXT_CHARS_PER_PAGE);
    expect(isLowTextPdf(`${perPage}\n${perPage}`, 2)).toBe(false);
  });

  it('ignores whitespace when counting', () => {
    expect(isLowTextPdf(' \n\t '.repeat(500), 1)).toBe(true);
  });
});

/** Render through the real loader, collecting what onPage receives. */
async function render(pdf: Buffer, maxPages: number) {
  const pages: RasterizedPdfPage[] = [];
  const result = await withPdf(pdf, (doc) => rasterizePdfPages(doc, { maxPages, onPage: async (page) => { pages.push(page); } }));
  return { pages, ...result };
}

describe('rasterizePdfPages', () => {
  it('renders each page as a JPEG within the 2048px ai-vision budget', async () => {
    const pdf = buildPdf([BLUE_SQUARE, BLUE_SQUARE]);

    const { pages, attempted, rendered } = await render(pdf, 10);

    expect(attempted).toBe(2);
    expect(rendered).toBe(2);
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

    const { pages } = await render(pdf, 1);

    const meta = await sharp(pages[0].buffer).metadata();
    expect(meta.width).toBeLessThanOrEqual(2048);
    expect(meta.height).toBeLessThanOrEqual(2048);
  }, 30000);

  it('paints the page content onto a white background', async () => {
    const pdf = buildPdf([BLUE_SQUARE]);

    const { pages } = await render(pdf, 1);

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

    const { pages } = await render(pdf, 1);

    const { data, info } = await sharp(pages[0].buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
    const dark = data.filter((v) => v < 100).length;
    // The words leave ink on the page; without font data they render as nothing.
    expect(dark / (info.width * info.height)).toBeGreaterThan(0.001);
  }, 30000);

  it('stops when handing a page on fails', async () => {
    const pdf = buildPdf([BLUE_SQUARE, BLUE_SQUARE]);
    const onPage = vi.fn(async () => { throw new Error('S3 down'); });

    await expect(withPdf(pdf, (doc) => rasterizePdfPages(doc, { maxPages: 2, onPage }))).rejects.toThrow('S3 down');
    expect(onPage).toHaveBeenCalledTimes(1);
  }, 30000);

  it('renders only the first maxPages pages', async () => {
    const pdf = buildPdf([BLUE_SQUARE, BLUE_SQUARE, BLUE_SQUARE, BLUE_SQUARE]);

    const { pages, attempted } = await render(pdf, 2);

    expect(attempted).toBe(2);
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2]);
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
