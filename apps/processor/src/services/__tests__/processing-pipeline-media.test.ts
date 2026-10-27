import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';

// OCR is the only dependency mocked here — tesseract loads a language model and
// is far too slow/heavy for a unit test. sharp and pdfjs run in-process against
// real fixture bytes, so those paths are exercised for real.
vi.mock('tesseract.js', () => ({
  default: {
    recognize: vi.fn().mockResolvedValue({ data: { text: 'RECOGNIZED TEXT' } }),
  },
}));

import {
  generateImageVariants,
  extractTextContent,
} from '../processing-pipeline';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
  0x54, 0x08, 0x99, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x5b, 0x7e, 0x2b,
  0x1c, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const PDF_BYTES = Buffer.from(
  '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n' +
    'xref\n0 4\n0000000000 65535 f \n' +
    '0000000010 00000 n \n0000000060 00000 n \n0000000110 00000 n \n' +
    'trailer<</Size 4/Root 1 0 R>>\nstartxref\n180\n%%EOF\n',
  'binary',
);

// A real 300x300 image (above the thumbnail/preset width caps) so the resize
// branch is exercised and sharp has real pixels to work with.
async function make300pxPng(): Promise<Buffer> {
  return sharp({
    create: { width: 300, height: 300, channels: 3, background: { r: 120, g: 80, b: 200 } },
  }).png().toBuffer();
}

describe('generateImageVariants', () => {
  it('produces a buffer for each standard preset from real image bytes', async () => {
    const variants = await generateImageVariants(await make300pxPng());
    for (const preset of ['ai-chat', 'ai-vision', 'thumbnail', 'preview']) {
      expect(Buffer.isBuffer(variants[preset].buffer)).toBe(true);
      expect(variants[preset].buffer.length).toBeGreaterThan(0);
    }
  }, 15000);

  it('reports each variant MIME type matching its encoded format', async () => {
    const variants = await generateImageVariants(await make300pxPng());
    expect(variants.thumbnail.mimeType).toBe('image/webp');
    expect(variants['ai-chat'].mimeType).toBe('image/jpeg');
    const thumbMeta = await sharp(variants.thumbnail.buffer).metadata();
    expect(thumbMeta.format).toBe('webp');
    expect(thumbMeta.width).toBeLessThanOrEqual(200);
  }, 15000);
});

describe('extractTextContent', () => {
  it('decodes plain text content directly', async () => {
    const text = await extractTextContent(Buffer.from('hello world', 'utf-8'), 'text/plain');
    expect(text).toBe('hello world');
  });

  it('pretty-prints JSON content', async () => {
    const text = await extractTextContent(Buffer.from('{"a":1}', 'utf-8'), 'application/json');
    expect(text).toContain('"a": 1');
  });

  it('returns a string (not null) for a valid PDF without throwing', async () => {
    const text = await extractTextContent(PDF_BYTES, 'application/pdf');
    expect(typeof text).toBe('string');
  }, 15000);

  it('runs OCR for image content types', async () => {
    const text = await extractTextContent(PNG_BYTES, 'image/png');
    expect(text).toBe('RECOGNIZED TEXT');
  });

  it('returns null for an unsupported content type', async () => {
    const text = await extractTextContent(Buffer.from([0, 1, 2]), 'application/zip');
    expect(text).toBeNull();
  });
});
