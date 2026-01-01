import { describe, it, expect } from 'vitest';
import {
  compress,
  decompress,
  shouldCompress,
  compressIfNeeded,
  decompressIfNeeded,
  COMPRESSION_THRESHOLD_BYTES,
  CompressionResult,
} from '../utils/compression';

describe('compression', () => {
  const smallContent = 'Hello, World!';
  const largeContent = 'a'.repeat(5000);
  const jsonContent = JSON.stringify({
    type: 'doc',
    content: Array.from({ length: 100 }, (_, i) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `This is paragraph ${i} with some content.` }],
    })),
  });

  describe('compress', () => {
    it('compresses a string successfully', () => {
      const result = compress(largeContent);

      expect(result).toBeTruthy();
      expect(typeof result.data).toBe('string');
      expect(result.data).not.toBe(largeContent);
      expect(result.originalSize).toBe(5000);
      expect(result.compressedSize).toBeLessThan(result.originalSize);
      expect(result.compressionRatio).toBeGreaterThan(0);
      expect(result.compressionRatio).toBeLessThan(1);
    });

    it('returns compression metadata', () => {
      const result = compress(largeContent);

      expect(result.originalSize).toBeGreaterThan(0);
      expect(result.compressedSize).toBeGreaterThan(0);
      expect(result.compressionRatio).toBe(result.compressedSize / result.originalSize);
    });

    it('achieves good compression for repetitive content', () => {
      const result = compress(largeContent);

      // Highly repetitive content should compress well (< 5% ratio)
      expect(result.compressionRatio).toBeLessThan(0.05);
    });

    it('achieves reasonable compression for JSON content', () => {
      const result = compress(jsonContent);

      // JSON content should compress to less than 50% of original
      expect(result.compressionRatio).toBeLessThan(0.5);
    });

    it('compresses small content successfully', () => {
      const result = compress(smallContent);

      expect(result).toBeTruthy();
      expect(typeof result.data).toBe('string');
      expect(result.originalSize).toBeGreaterThan(0);
    });

    it('handles empty string', () => {
      const result = compress('');

      expect(result).toBeTruthy();
      expect(result.originalSize).toBe(0);
      expect(result.compressedSize).toBeGreaterThan(0); // Zlib header adds overhead
      expect(result.compressionRatio).toBe(1); // 0 / 0 should return 1
    });

    it('throws error for non-string input', () => {
      expect(() => compress(null as unknown as string)).toThrow(
        'Content to compress must be a string'
      );
      expect(() => compress(undefined as unknown as string)).toThrow(
        'Content to compress must be a string'
      );
      expect(() => compress(123 as unknown as string)).toThrow(
        'Content to compress must be a string'
      );
      expect(() => compress({} as unknown as string)).toThrow(
        'Content to compress must be a string'
      );
    });

    it('handles special characters', () => {
      const specialChars = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/~`\n\t\r';
      const result = compress(specialChars);
      const decompressed = decompress(result.data);

      expect(decompressed).toBe(specialChars);
    });

    it('handles unicode characters', () => {
      const unicode = '你好世界 🌍 مرحبا العالم';
      const result = compress(unicode);
      const decompressed = decompress(result.data);

      expect(decompressed).toBe(unicode);
    });

    it('handles emoji content', () => {
      const emojis = '😀🎉🚀💻🔥✨🎯🌟';
      const result = compress(emojis);
      const decompressed = decompress(result.data);

      expect(decompressed).toBe(emojis);
    });
  });

  describe('decompress', () => {
    it('decompresses compressed data successfully', () => {
      const compressed = compress(largeContent);
      const decompressed = decompress(compressed.data);

      expect(decompressed).toBe(largeContent);
    });

    it('maintains data integrity for JSON content', () => {
      const compressed = compress(jsonContent);
      const decompressed = decompress(compressed.data);

      expect(decompressed).toBe(jsonContent);
      expect(JSON.parse(decompressed)).toEqual(JSON.parse(jsonContent));
    });

    it('maintains data integrity through multiple cycles', () => {
      let current = jsonContent;

      for (let i = 0; i < 5; i++) {
        const compressed = compress(current);
        current = decompress(compressed.data);
      }

      expect(current).toBe(jsonContent);
    });

    it('throws error for empty string', () => {
      expect(() => decompress('')).toThrow('Compressed data must be a non-empty string');
    });

    it('throws error for non-string input', () => {
      expect(() => decompress(null as unknown as string)).toThrow(
        'Compressed data must be a non-empty string'
      );
      expect(() => decompress(undefined as unknown as string)).toThrow(
        'Compressed data must be a non-empty string'
      );
    });

    it('throws error for corrupted base64 data', () => {
      expect(() => decompress('not-valid-base64!!!')).toThrow('Decompression failed');
    });

    it('throws error for valid base64 but invalid compressed data', () => {
      // Valid base64, but not valid zlib data
      const invalidCompressedData = btoa('this is not compressed data');
      expect(() => decompress(invalidCompressedData)).toThrow('Decompression failed');
    });

    it('throws error for truncated compressed data', () => {
      const compressed = compress(largeContent);
      // Truncate the data
      const truncated = compressed.data.substring(0, compressed.data.length / 2);
      expect(() => decompress(truncated)).toThrow('Decompression failed');
    });
  });

  describe('shouldCompress', () => {
    it('returns false for content below threshold', () => {
      const smallData = 'a'.repeat(COMPRESSION_THRESHOLD_BYTES - 1);
      expect(shouldCompress(smallData)).toBe(false);
    });

    it('returns true for content at threshold', () => {
      const thresholdData = 'a'.repeat(COMPRESSION_THRESHOLD_BYTES);
      expect(shouldCompress(thresholdData)).toBe(true);
    });

    it('returns true for content above threshold', () => {
      const largeData = 'a'.repeat(COMPRESSION_THRESHOLD_BYTES + 1000);
      expect(shouldCompress(largeData)).toBe(true);
    });

    it('returns false for empty string', () => {
      expect(shouldCompress('')).toBe(false);
    });

    it('returns false for non-string input', () => {
      expect(shouldCompress(null as unknown as string)).toBe(false);
      expect(shouldCompress(undefined as unknown as string)).toBe(false);
      expect(shouldCompress(123 as unknown as string)).toBe(false);
    });

    it('correctly accounts for multi-byte unicode characters', () => {
      // Each emoji is 4 bytes in UTF-8
      const emojiCount = Math.ceil(COMPRESSION_THRESHOLD_BYTES / 4);
      const emojis = '🔥'.repeat(emojiCount);
      expect(shouldCompress(emojis)).toBe(true);
    });
  });

  describe('compressIfNeeded', () => {
    it('compresses content above threshold', () => {
      const result = compressIfNeeded(largeContent);

      expect(result.compressed).toBe(true);
      expect(result.data).not.toBe(largeContent);
      expect(result.compressionRatio).toBeLessThan(1);
    });

    it('does not compress content below threshold', () => {
      const result = compressIfNeeded(smallContent);

      expect(result.compressed).toBe(false);
      expect(result.data).toBe(smallContent);
      expect(result.compressionRatio).toBe(1);
    });

    it('returns correct metadata for uncompressed content', () => {
      const result = compressIfNeeded(smallContent);

      expect(result.originalSize).toBeGreaterThan(0);
      expect(result.compressedSize).toBe(result.originalSize);
      expect(result.compressionRatio).toBe(1);
    });
  });

  describe('decompressIfNeeded', () => {
    it('decompresses when isCompressed is true', () => {
      const compressed = compress(largeContent);
      const result = decompressIfNeeded(compressed.data, true);

      expect(result).toBe(largeContent);
    });

    it('returns data as-is when isCompressed is false', () => {
      const result = decompressIfNeeded(smallContent, false);

      expect(result).toBe(smallContent);
    });

    it('handles round-trip with compressIfNeeded', () => {
      // Large content - gets compressed
      const compressedResult = compressIfNeeded(largeContent);
      const decompressed = decompressIfNeeded(compressedResult.data, compressedResult.compressed);
      expect(decompressed).toBe(largeContent);

      // Small content - not compressed
      const uncompressedResult = compressIfNeeded(smallContent);
      const returned = decompressIfNeeded(uncompressedResult.data, uncompressedResult.compressed);
      expect(returned).toBe(smallContent);
    });
  });

  describe('COMPRESSION_THRESHOLD_BYTES', () => {
    it('is set to 1KB (1024 bytes)', () => {
      expect(COMPRESSION_THRESHOLD_BYTES).toBe(1024);
    });
  });

  describe('round-trip integrity', () => {
    const testCases = [
      { name: 'simple text', value: 'Hello, World!' },
      { name: 'JSON document', value: jsonContent },
      { name: 'HTML content', value: '<div><p>Hello <strong>World</strong></p></div>'.repeat(100) },
      { name: 'markdown', value: '# Heading\n\n**Bold** and *italic*\n\n- List item\n'.repeat(50) },
      { name: 'whitespace', value: '   \t\n\r   '.repeat(200) },
      { name: 'mixed unicode', value: 'English 日本語 العربية 🎉'.repeat(50) },
      { name: 'code block', value: 'function test() {\n  return "hello";\n}\n'.repeat(100) },
    ];

    testCases.forEach(({ name, value }) => {
      it(`maintains integrity for ${name}`, () => {
        const compressed = compress(value);
        const decompressed = decompress(compressed.data);

        expect(decompressed).toBe(value);
      });
    });
  });

  describe('large document handling', () => {
    it('handles 1MB document', () => {
      const oneMB = 'x'.repeat(1024 * 1024);
      const compressed = compress(oneMB);
      const decompressed = decompress(compressed.data);

      expect(decompressed).toBe(oneMB);
      expect(decompressed.length).toBe(oneMB.length);
    });

    it('handles 2MB document with good compression', () => {
      // Realistic document content (JSON with some repetition)
      const documentChunk = JSON.stringify({
        type: 'paragraph',
        content: [{ type: 'text', text: 'This is a sample paragraph with some content. ' }],
      });
      const twoMBContent = documentChunk.repeat(Math.ceil((2 * 1024 * 1024) / documentChunk.length));

      const compressed = compress(twoMBContent);
      const decompressed = decompress(compressed.data);

      expect(decompressed).toBe(twoMBContent);
      // Should achieve at least 80% compression for repetitive content
      expect(compressed.compressionRatio).toBeLessThan(0.2);
    });

    it('compression is deterministic', () => {
      const compressed1 = compress(largeContent);
      const compressed2 = compress(largeContent);

      expect(compressed1.data).toBe(compressed2.data);
      expect(compressed1.compressedSize).toBe(compressed2.compressedSize);
      expect(compressed1.compressionRatio).toBe(compressed2.compressionRatio);
    });
  });
});
