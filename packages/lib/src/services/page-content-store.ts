import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { hashWithPrefix } from '../utils/hash-utils';
import {
  compress,
  compressIfNeeded,
  decompressIfNeeded,
  COMPRESSION_THRESHOLD_BYTES,
} from '../utils/compression';
import type { PageContentFormat } from '../content/page-content-format';

const CONTENT_SUBDIR = 'page-content';
const CONTENT_REF_REGEX = /^[a-f0-9]{64}$/i;

/**
 * Magic header to identify compressed content.
 * Format: PSCOMP\x00 followed by compressed data
 */
const COMPRESSION_MAGIC = 'PSCOMP\0';

/**
 * Options for writing page content
 */
export interface WritePageContentOptions {
  /**
   * Whether to enable compression.
   * - true: Always compress content
   * - false: Never compress content
   * - 'auto' (default): Compress content if size >= COMPRESSION_THRESHOLD_BYTES
   */
  compress?: boolean | 'auto';
}

/**
 * Result of writing page content
 */
export interface WritePageContentResult {
  /** Content reference (SHA-256 hash) */
  ref: string;
  /** Original content size in bytes */
  size: number;
  /** Whether content was compressed */
  compressed: boolean;
  /** Stored size in bytes (may be smaller if compressed) */
  storedSize: number;
  /** Compression ratio (1.0 if not compressed) */
  compressionRatio: number;
}

function getContentRoot(): string {
  const base = process.env.PAGE_CONTENT_STORAGE_PATH
    || process.env.FILE_STORAGE_PATH
    || join(process.cwd(), 'storage');
  return join(base, CONTENT_SUBDIR);
}

function assertContentRef(ref: string): void {
  if (!CONTENT_REF_REGEX.test(ref)) {
    throw new Error('Invalid content reference');
  }
}

function getContentPath(ref: string): string {
  assertContentRef(ref);
  const root = getContentRoot();
  const prefix = ref.slice(0, 2);
  return join(root, prefix, ref);
}

/**
 * Determines if content should be compressed based on options
 */
function shouldApplyCompression(
  contentSize: number,
  options?: WritePageContentOptions
): boolean {
  const compressOption = options?.compress ?? 'auto';

  if (compressOption === true) {
    return true;
  }

  if (compressOption === false) {
    return false;
  }

  // 'auto': compress if content size >= threshold
  return contentSize >= COMPRESSION_THRESHOLD_BYTES;
}

/**
 * Writes page content to storage with optional compression.
 *
 * Content is stored using content-addressable storage where the reference
 * is a SHA-256 hash of the format and original content. This ensures
 * identical content always produces the same reference.
 *
 * @param content - The content string to store
 * @param format - The content format (text, html, json, tiptap)
 * @param options - Optional settings for compression
 * @returns Result with reference, size, and compression metadata
 *
 * @example
 * ```typescript
 * // Auto-compress (compresses if content >= 1KB)
 * const result = await writePageContent(content, 'tiptap');
 *
 * // Force compression
 * const result = await writePageContent(content, 'tiptap', { compress: true });
 *
 * // Disable compression
 * const result = await writePageContent(content, 'tiptap', { compress: false });
 * ```
 */
export async function writePageContent(
  content: string,
  format: PageContentFormat,
  options?: WritePageContentOptions
): Promise<WritePageContentResult> {
  // Hash is computed from original content to ensure same reference
  // for identical content regardless of compression
  const ref = hashWithPrefix(format, content);
  const contentPath = getContentPath(ref);
  const dir = dirname(contentPath);

  const originalSize = Buffer.byteLength(content, 'utf8');
  const applyCompression = shouldApplyCompression(originalSize, options);

  let dataToStore: string;
  let compressed = false;
  let storedSize: number;
  let compressionRatio = 1;

  if (applyCompression) {
    // If compress: true was explicitly set, use compress() directly to force compression
    // Otherwise use compressIfNeeded() which respects the size threshold
    const forceCompression = options?.compress === true;
    const compressionResult = forceCompression ?
      { ...compress(content), compressed: true } :
      compressIfNeeded(content);

    if (compressionResult.compressed) {
      // Prepend magic header to identify compressed content
      dataToStore = COMPRESSION_MAGIC + compressionResult.data;
      compressed = true;
      storedSize = Buffer.byteLength(dataToStore, 'utf8');
      compressionRatio = compressionResult.compressionRatio;
    } else {
      // Content was below threshold after check
      dataToStore = content;
      storedSize = originalSize;
    }
  } else {
    dataToStore = content;
    storedSize = originalSize;
  }

  await fs.mkdir(dir, { recursive: true });

  try {
    await fs.writeFile(contentPath, dataToStore, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || (error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    // File already exists - content-addressable, so we're done
  }

  return {
    ref,
    size: originalSize,
    compressed,
    storedSize,
    compressionRatio,
  };
}

/**
 * Reads page content from storage, automatically decompressing if needed.
 *
 * Maintains backward compatibility with uncompressed content by detecting
 * the compression magic header. If content doesn't have the header, it's
 * returned as-is (uncompressed legacy content).
 *
 * @param ref - The content reference (SHA-256 hash)
 * @returns The original content string
 * @throws Error if reference is invalid or content cannot be read/decompressed
 *
 * @example
 * ```typescript
 * const content = await readPageContent('abc123...');
 * const document = JSON.parse(content);
 * ```
 */
export async function readPageContent(ref: string): Promise<string> {
  const contentPath = getContentPath(ref);
  const storedContent = await fs.readFile(contentPath, 'utf8');

  // Check for compression magic header
  if (storedContent.startsWith(COMPRESSION_MAGIC)) {
    // Extract compressed data (after magic header)
    const compressedData = storedContent.slice(COMPRESSION_MAGIC.length);
    return decompressIfNeeded(compressedData, true);
  }

  // No magic header - uncompressed content (backward compatible)
  return storedContent;
}

/**
 * Checks if stored content is compressed without fully reading it.
 * Useful for inspecting content state without decompression overhead.
 *
 * @param ref - The content reference (SHA-256 hash)
 * @returns True if content is stored in compressed format
 */
export async function isContentCompressed(ref: string): Promise<boolean> {
  const contentPath = getContentPath(ref);

  // Read just enough bytes to check for magic header
  const fd = await fs.open(contentPath, 'r');
  try {
    const buffer = Buffer.alloc(COMPRESSION_MAGIC.length);
    await fd.read(buffer, 0, COMPRESSION_MAGIC.length, 0);
    return buffer.toString('utf8') === COMPRESSION_MAGIC;
  } finally {
    await fd.close();
  }
}

/**
 * Gets content metadata without reading the full content.
 *
 * @param ref - The content reference (SHA-256 hash)
 * @returns Metadata about the stored content
 */
export async function getContentMetadata(ref: string): Promise<{
  storedSize: number;
  compressed: boolean;
}> {
  const contentPath = getContentPath(ref);
  const stats = await fs.stat(contentPath);
  const compressed = await isContentCompressed(ref);

  return {
    storedSize: stats.size,
    compressed,
  };
}

// Re-export compression threshold for use by other modules
export { COMPRESSION_THRESHOLD_BYTES };
