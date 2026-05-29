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
import type { PDFLoadingTask, PDFTextItem } from '../types/pdfjs';

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

export type ImageVariants = Record<string, Buffer>;

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
  if (
    contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    contentType === 'application/msword'
  ) {
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

async function extractPdfText(bytes: Buffer): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  const getDocument = pdfjsLib.getDocument as unknown as
    (params: { data: Uint8Array; disableWorker: boolean }) => PDFLoadingTask;
  const pdf = await getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;

  const parts: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    parts.push(textContent.items.map((item: PDFTextItem) => item.str).join(' '));
  }
  return cleanText(parts.join('\n\n'));
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
    variants[name] = await pipeline.toBuffer();
  }
  return variants;
}

async function withTempFile<T>(bytes: Buffer, suffix: string, work: (inputPath: string) => Promise<T>): Promise<T> {
  const inputPath = path.join(os.tmpdir(), `pipeline-${crypto.randomUUID()}${suffix}`);
  try {
    await fs.writeFile(inputPath, bytes);
    return await work(inputPath);
  } finally {
    await fs.unlink(inputPath).catch(() => {});
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
    const thumbPath = `${inputPath}-thumb.webp`;
    try {
      await execFileAsync(
        'ffmpeg',
        ['-y', '-i', inputPath, '-vf', 'select=eq(n\\,0)', '-vframes', '1', '-f', 'webp', thumbPath],
        { timeout: FFMPEG_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      );
      return await fs.readFile(thumbPath);
    } finally {
      await fs.unlink(thumbPath).catch(() => {});
    }
  });
}
