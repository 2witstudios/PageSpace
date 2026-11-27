import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import mammoth from 'mammoth';
import Tesseract from 'tesseract.js';
import {
  detectContentTypeFromBytes,
  type DetectedContentType,
} from './content-detector';
import { IMAGE_PRESETS } from '../types';
import type { PDFDocumentProxy, PDFLoadingTask } from '../types/pdfjs';
import { composePageText, composeDocumentText } from './pdf-text-layout';

const execFileAsync = promisify(execFile);

/**
 * Pure processing pipeline — single-responsibility functions that accept bytes
 * and return typed results. The security core (hash verification + content-type
 * gating) lives here so the S3-pull adapter can verify stored bytes before any
 * Postgres write. Magika is invoked through `detectContentType`, the sole
 * content-detection entry point.
 */

export type MagikaResult = DetectedContentType;

const HEX_64 = /^[0-9a-f]{64}$/i;

/**
 * Zero-trust: SHA-256 the actual bytes and compare to the client-supplied hash.
 * Content integrity (not a secret), so a direct compare is correct — there is no
 * preimage an attacker can grind out via timing.
 */
export function verifyContentHash(bytes: Buffer, expectedHash: string): boolean {
  if (!HEX_64.test(expectedHash)) return false;
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  return actual === expectedHash.toLowerCase();
}

export function detectContentType(bytes: Buffer): Promise<MagikaResult> {
  return detectContentTypeFromBytes(bytes);
}

// Magika labels that must never be stored regardless of declared MIME type:
// browser-executable markup, scripts, and native executables. Magika's actual
// bytes-classification overrides whatever Content-Type the client declared.
const BLOCKED_LABELS: ReadonlySet<string> = new Set([
  // executables / runnable binaries
  'elf', 'pebin', 'macho', 'msdos', 'dex', 'msi',
  // markup that executes script in a browser
  'html', 'xhtml', 'svg',
  // scripts
  'javascript', 'typescript', 'python', 'shell', 'batch', 'powershell',
  'ruby', 'perl', 'php', 'vba', 'lua', 'asp', 'jsp', 'awk', 'tcl', 'vbscript',
]);

export function isAllowedContentType(result: MagikaResult): boolean {
  return !BLOCKED_LABELS.has(result.label.toLowerCase());
}

export interface ImageVariant {
  buffer: Buffer;
  mimeType: string;
}
export type ImageVariants = Record<string, ImageVariant>;

export interface VideoMetadata {
  duration?: number;
  width?: number;
  height?: number;
}

const FFMPEG_TIMEOUT_MS = 120_000;
const FFPROBE_TIMEOUT_MS = 30_000;

const TEXT_DECODE_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv']);

/**
 * Extract searchable text from a document or image. Documents (PDF/DOCX/text/
 * JSON) are parsed in-process; images are run through OCR. Returns null for any
 * content type with no text to extract.
 */
export async function extractTextContent(bytes: Buffer, contentType: string): Promise<string | null> {
  if (contentType === 'application/pdf') {
    return extractPdfText(bytes);
  }
  // mammoth only reads OOXML .docx — not legacy binary .doc. .doc falls through
  // to null and is handled as a non-text (visual) file.
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return cleanText(result.value);
  }
  if (TEXT_DECODE_TYPES.has(contentType)) {
    return cleanText(bytes.toString('utf-8'));
  }
  if (contentType === 'application/json') {
    return cleanText(JSON.stringify(JSON.parse(bytes.toString('utf-8')), null, 2));
  }
  if (contentType.startsWith('image/')) {
    const { data } = await Tesseract.recognize(bytes, 'eng');
    return cleanText(data.text);
  }
  return null;
}

function cleanText(text: string): string {
  return text.replace(/\0/g, '').trim();
}

interface PdfLoadParams {
  data: Uint8Array;
  disableWorker: boolean;
  standardFontDataUrl?: string;
  cMapUrl?: string;
  cMapPacked?: boolean;
}

/**
 * pdf.js's bundled font and CMap data, as directory paths (pdf.js reads them
 * from disk in Node). Without them the standard 14 fonts and CJK text fail to
 * load: rendering drops the text and extraction logs a warning per font.
 */
function pdfjsAssetPaths(): Pick<PdfLoadParams, 'standardFontDataUrl' | 'cMapUrl' | 'cMapPacked'> {
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return {
    standardFontDataUrl: `${path.join(root, 'standard_fonts')}${path.sep}`,
    cMapUrl: `${path.join(root, 'cmaps')}${path.sep}`,
    cMapPacked: true,
  };
}

async function loadPdf(bytes: Buffer): Promise<PDFDocumentProxy> {
  // The legacy build is pdf.js's Node build: it polyfills Path2D, DOMMatrix and
  // ImageData from @napi-rs/canvas, which page rendering needs (text is drawn
  // through Path2D). The modern build assumes a browser.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const getDocument = pdfjsLib.getDocument as unknown as (params: PdfLoadParams) => PDFLoadingTask;
  return getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    ...pdfjsAssetPaths(),
  }).promise;
}

export interface PdfContent {
  text: string;
  pageCount: number;
}

/** The PDF's text layer and page count. Bytes in, plain result out. */
export async function extractPdfContent(bytes: Buffer): Promise<PdfContent> {
  const pdf = await loadPdf(bytes);
  try {
    const parts: string[] = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      parts.push(composePageText(textContent.items));
    }
    return { text: cleanText(composeDocumentText(parts)), pageCount: pdf.numPages };
  } finally {
    await pdf.destroy().catch(() => {});
  }
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  return (await extractPdfContent(bytes)).text;
}

/**
 * Below this many non-whitespace characters per page, a PDF's text layer is
 * not its content: a scan with page numbers or a stamp, or no text at all.
 */
export const LOW_TEXT_CHARS_PER_PAGE = 32;

/** Whether a PDF's extracted text is too thin to stand for it (a scan). */
export function isLowTextPdf(text: string, pageCount: number): boolean {
  const meaningful = text.replace(/\s+/g, '').length;
  return meaningful < LOW_TEXT_CHARS_PER_PAGE * Math.max(pageCount, 1);
}

/** Cache preset name for a rasterized PDF page (1-based). Served by /cache/:hash/:preset. */
export function pdfPagePreset(pageNumber: number): string {
  return `pdf-page-${pageNumber}`;
}

/**
 * How many leading pages of a low-text PDF are rasterized. Rendering is the
 * slow part of processing a scan, and each page is one cache object.
 */
export const DEFAULT_MAX_RASTERIZED_PDF_PAGES = 50;

export function resolveMaxRasterizedPdfPages(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.PDF_RASTER_MAX_PAGES);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_RASTERIZED_PDF_PAGES;
}

export interface RasterizedPdfPage {
  pageNumber: number;
  buffer: Buffer;
  mimeType: 'image/jpeg';
}

export interface RasterizePdfResult {
  pages: RasterizedPdfPage[];
  /** Leading pages rendering was tried on: min(maxPages, numPages). */
  attempted: number;
}

/**
 * Render the first `maxPages` pages to JPEG, each fitted inside the ai-vision
 * preset's 2048px budget on its long side and encoded at its quality. A page
 * that fails to render is skipped; the rest still come back. Bytes in, page
 * images out.
 */
export async function rasterizePdfPages(bytes: Buffer, options: { maxPages: number }): Promise<RasterizePdfResult> {
  const budget = IMAGE_PRESETS['ai-vision'];
  const pdf = await loadPdf(bytes);
  try {
    const attempted = Math.min(options.maxPages, pdf.numPages);
    const pages: RasterizedPdfPage[] = [];
    for (let pageNumber = 1; pageNumber <= attempted; pageNumber++) {
      try {
        const page = await pdf.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(budget.maxWidth / base.width, budget.maxWidth / base.height);
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.floor(viewport.width));
        const height = Math.max(1, Math.floor(viewport.height));
        const target = pdf.canvasFactory.create(width, height);
        try {
          await page.render({ canvasContext: target.context, viewport }).promise;
          const png = target.canvas.toBuffer('image/png');
          const buffer = await sharp(png)
            // The canvas starts transparent; a page is white paper.
            .flatten({ background: '#ffffff' })
            .resize(budget.maxWidth, budget.maxWidth, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: budget.quality, progressive: true, mozjpeg: true })
            .toBuffer();
          pages.push({ pageNumber, buffer, mimeType: 'image/jpeg' });
        } finally {
          pdf.canvasFactory.destroy(target);
          page.cleanup();
        }
      } catch {
        // One unrenderable page (a broken image stream) must not cost the rest.
        continue;
      }
    }
    return { pages, attempted };
  } finally {
    await pdf.destroy().catch(() => {});
  }
}

/** Resize+re-encode the image into every standard preset. Bytes in, bytes per preset out. */
export async function generateImageVariants(bytes: Buffer): Promise<ImageVariants> {
  const variants: ImageVariants = {};
  const { width } = await sharp(bytes).metadata();
  for (const [name, preset] of Object.entries(IMAGE_PRESETS)) {
    let pipeline = sharp(bytes).rotate();
    if (width && width > preset.maxWidth) {
      pipeline = pipeline.resize(preset.maxWidth, preset.maxHeight, { fit: 'inside', withoutEnlargement: true });
    }
    if (preset.format === 'jpeg') pipeline = pipeline.jpeg({ quality: preset.quality, progressive: true, mozjpeg: true });
    else if (preset.format === 'webp') pipeline = pipeline.webp({ quality: preset.quality, effort: 4 });
    else pipeline = pipeline.png({ quality: preset.quality, compressionLevel: 9, adaptiveFiltering: true });
    variants[name] = { buffer: await pipeline.toBuffer(), mimeType: `image/${preset.format}` };
  }
  return variants;
}

async function withTempFile<T>(bytes: Buffer, suffix: string, work: (inputPath: string) => Promise<T>): Promise<T> {
  // mkdtemp creates a private (0700), unpredictably-named directory, avoiding the
  // symlink/race hazards of writing a known-named file into the shared temp dir.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-'));
  const inputPath = path.join(dir, `input${suffix}`);
  try {
    await fs.writeFile(inputPath, bytes);
    return await work(inputPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Probe video dimensions + duration via ffprobe. Bytes in, plain metadata object out. */
export function extractVideoMetadata(bytes: Buffer): Promise<VideoMetadata> {
  return withTempFile(bytes, '.video', async (inputPath) => {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', inputPath],
      { timeout: FFPROBE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 5 * 1024 * 1024 },
    );
    const probe = JSON.parse(stdout) as { streams?: Array<{ duration?: string; width?: number; height?: number }> };
    const stream = probe.streams?.[0];
    return {
      duration: stream?.duration ? parseFloat(stream.duration) : undefined,
      width: stream?.width,
      height: stream?.height,
    };
  });
}

/** Grab the first frame as a webp thumbnail via ffmpeg. Bytes in, thumbnail bytes out. */
export function extractVideoThumbnail(bytes: Buffer): Promise<Buffer> {
  return withTempFile(bytes, '.video', async (inputPath) => {
    // Thumbnail lands inside the same private temp dir, cleaned up by withTempFile.
    const thumbPath = `${inputPath}-thumb.webp`;
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', inputPath, '-vf', 'select=eq(n\\,0)', '-vframes', '1', '-f', 'webp', thumbPath],
      { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
    );
    return fs.readFile(thumbPath);
  });
}
