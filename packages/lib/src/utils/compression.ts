import pako from 'pako';

/**
 * Compression utilities for efficient storage of document version content.
 *
 * Uses pako (zlib) for compression/decompression with base64 encoding
 * for safe storage and transmission.
 */

/**
 * Compression result with metadata for storage
 */
export interface CompressionResult {
  /** Base64-encoded compressed data */
  data: string;
  /** Original size in bytes before compression */
  originalSize: number;
  /** Compressed size in bytes */
  compressedSize: number;
  /** Compression ratio (0-1, lower is better compression) */
  compressionRatio: number;
}

/**
 * Minimum size threshold for compression (1KB)
 * Content smaller than this is not worth compressing due to overhead
 */
export const COMPRESSION_THRESHOLD_BYTES = 1024;

/**
 * Compresses a string using zlib deflate and returns base64-encoded result.
 *
 * @param content - The string content to compress
 * @returns CompressionResult with compressed data and metadata
 * @throws Error if content is not a valid string
 *
 * @example
 * ```typescript
 * const result = compress(JSON.stringify(documentContent));
 * // { data: 'eJzLSM3JyVc...', originalSize: 5000, compressedSize: 1200, compressionRatio: 0.24 }
 * ```
 */
export function compress(content: string): CompressionResult {
  if (typeof content !== 'string') {
    throw new Error('Content to compress must be a string');
  }

  // Convert string to Uint8Array
  const encoder = new TextEncoder();
  const inputBytes = encoder.encode(content);
  const originalSize = inputBytes.length;

  // Compress using pako deflate with maximum compression level
  const compressed = pako.deflate(inputBytes, { level: 9 });

  // Convert to base64 for safe storage
  const base64 = uint8ArrayToBase64(compressed);
  const compressedSize = compressed.length;

  return {
    data: base64,
    originalSize,
    compressedSize,
    compressionRatio: originalSize > 0 ? compressedSize / originalSize : 1,
  };
}

/**
 * Decompresses a base64-encoded compressed string back to original content.
 *
 * @param compressedData - Base64-encoded compressed data
 * @returns The original decompressed string
 * @throws Error if data is invalid or corrupted
 *
 * @example
 * ```typescript
 * const original = decompress(compressedResult.data);
 * const document = JSON.parse(original);
 * ```
 */
export function decompress(compressedData: string): string {
  if (typeof compressedData !== 'string' || compressedData.length === 0) {
    throw new Error('Compressed data must be a non-empty string');
  }

  try {
    // Convert base64 back to Uint8Array
    const compressed = base64ToUint8Array(compressedData);

    // Decompress using pako inflate
    const decompressed = pako.inflate(compressed);

    // Convert back to string
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(decompressed);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Decompression failed: ${message}`);
  }
}

/**
 * Determines if content should be compressed based on size threshold.
 *
 * @param content - The string content to check
 * @returns true if content size exceeds compression threshold
 */
export function shouldCompress(content: string): boolean {
  if (typeof content !== 'string') {
    return false;
  }
  const encoder = new TextEncoder();
  return encoder.encode(content).length >= COMPRESSION_THRESHOLD_BYTES;
}

/**
 * Compresses content only if it exceeds the size threshold.
 * Returns original content with metadata if below threshold.
 *
 * @param content - The string content to potentially compress
 * @returns CompressionResult, with compressionRatio of 1 if not compressed
 */
export function compressIfNeeded(content: string): CompressionResult & { compressed: boolean } {
  if (!shouldCompress(content)) {
    const encoder = new TextEncoder();
    const size = encoder.encode(content).length;
    return {
      data: content,
      originalSize: size,
      compressedSize: size,
      compressionRatio: 1,
      compressed: false,
    };
  }

  const result = compress(content);
  return {
    ...result,
    compressed: true,
  };
}

/**
 * Decompresses data if it was compressed, otherwise returns as-is.
 *
 * @param data - The data string (either compressed or original)
 * @param isCompressed - Whether the data is compressed
 * @returns The original content string
 */
export function decompressIfNeeded(data: string, isCompressed: boolean): string {
  if (!isCompressed) {
    return data;
  }
  return decompress(data);
}

/**
 * Converts a Uint8Array to a base64 string.
 * Uses btoa for compatibility across environments.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  // Convert Uint8Array to binary string
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // Use btoa to convert to base64
  return btoa(binary);
}

/**
 * Converts a base64 string to a Uint8Array.
 * Uses atob for compatibility across environments.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  // Use atob to decode base64 to binary string
  const binary = atob(base64);
  // Convert binary string to Uint8Array
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
