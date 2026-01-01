import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  writePageContent,
  readPageContent,
  isContentCompressed,
  getContentMetadata,
  COMPRESSION_THRESHOLD_BYTES,
} from '../services/page-content-store';

describe('page-content-store', () => {
  const testStoragePath = join(process.cwd(), 'test-storage-page-content');

  beforeEach(async () => {
    // Set up test storage path
    process.env.PAGE_CONTENT_STORAGE_PATH = testStoragePath;
    // Clean up any existing test storage
    try {
      await fs.rm(testStoragePath, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  });

  afterEach(async () => {
    // Clean up test storage
    delete process.env.PAGE_CONTENT_STORAGE_PATH;
    try {
      await fs.rm(testStoragePath, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  });

  // Test content of various sizes
  const smallContent = 'Hello, World!';
  const largeContent = 'a'.repeat(5000);
  const jsonContent = JSON.stringify({
    type: 'doc',
    content: Array.from({ length: 100 }, (_, i) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `This is paragraph ${i} with some content.` }],
    })),
  });

  describe('writePageContent', () => {
    it('writes small content without compression by default', async () => {
      const result = await writePageContent(smallContent, 'text');

      expect(result.ref).toMatch(/^[a-f0-9]{64}$/i);
      expect(result.size).toBe(Buffer.byteLength(smallContent, 'utf8'));
      expect(result.compressed).toBe(false);
      expect(result.storedSize).toBe(result.size);
      expect(result.compressionRatio).toBe(1);
    });

    it('writes large content with compression by default', async () => {
      const result = await writePageContent(largeContent, 'text');

      expect(result.ref).toMatch(/^[a-f0-9]{64}$/i);
      expect(result.size).toBe(Buffer.byteLength(largeContent, 'utf8'));
      expect(result.compressed).toBe(true);
      expect(result.storedSize).toBeLessThan(result.size);
      expect(result.compressionRatio).toBeLessThan(1);
    });

    it('writes JSON content with good compression', async () => {
      const result = await writePageContent(jsonContent, 'tiptap');

      expect(result.compressed).toBe(true);
      expect(result.compressionRatio).toBeLessThan(0.5);
    });

    it('forces compression when compress: true', async () => {
      const result = await writePageContent(smallContent, 'text', { compress: true });

      expect(result.compressed).toBe(true);
      expect(result.storedSize).toBeGreaterThan(result.size); // Overhead for small content
    });

    it('disables compression when compress: false', async () => {
      const result = await writePageContent(largeContent, 'text', { compress: false });

      expect(result.compressed).toBe(false);
      expect(result.storedSize).toBe(result.size);
      expect(result.compressionRatio).toBe(1);
    });

    it('uses auto compression by default', async () => {
      // Below threshold - no compression
      const smallResult = await writePageContent(smallContent, 'text');
      expect(smallResult.compressed).toBe(false);

      // At/above threshold - compression
      const thresholdContent = 'a'.repeat(COMPRESSION_THRESHOLD_BYTES);
      const thresholdResult = await writePageContent(thresholdContent, 'text');
      expect(thresholdResult.compressed).toBe(true);
    });

    it('generates consistent ref for same content', async () => {
      const result1 = await writePageContent(largeContent, 'text');
      const result2 = await writePageContent(largeContent, 'text');

      expect(result1.ref).toBe(result2.ref);
    });

    it('generates different ref for different formats', async () => {
      const textResult = await writePageContent(largeContent, 'text');
      const htmlResult = await writePageContent(largeContent, 'html');

      expect(textResult.ref).not.toBe(htmlResult.ref);
    });

    it('handles empty string', async () => {
      const result = await writePageContent('', 'text');

      expect(result.ref).toMatch(/^[a-f0-9]{64}$/i);
      expect(result.size).toBe(0);
      expect(result.compressed).toBe(false);
    });

    it('handles special characters', async () => {
      const specialContent = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/~`\n\t\r'.repeat(50);
      const result = await writePageContent(specialContent, 'text');

      expect(result.ref).toMatch(/^[a-f0-9]{64}$/i);
    });

    it('handles unicode content', async () => {
      const unicodeContent = '你好世界 🌍 مرحبا العالم'.repeat(100);
      const result = await writePageContent(unicodeContent, 'text');

      expect(result.ref).toMatch(/^[a-f0-9]{64}$/i);
    });

    it('does not throw for existing content (content-addressable)', async () => {
      const result1 = await writePageContent(largeContent, 'text');
      const result2 = await writePageContent(largeContent, 'text');

      expect(result1.ref).toBe(result2.ref);
      expect(result2.compressed).toBe(result1.compressed);
    });
  });

  describe('readPageContent', () => {
    it('reads uncompressed content', async () => {
      const result = await writePageContent(smallContent, 'text');
      const content = await readPageContent(result.ref);

      expect(content).toBe(smallContent);
    });

    it('reads and decompresses compressed content', async () => {
      const result = await writePageContent(largeContent, 'text');
      expect(result.compressed).toBe(true);

      const content = await readPageContent(result.ref);
      expect(content).toBe(largeContent);
    });

    it('reads JSON content correctly', async () => {
      const result = await writePageContent(jsonContent, 'tiptap');
      const content = await readPageContent(result.ref);

      expect(content).toBe(jsonContent);
      expect(JSON.parse(content)).toEqual(JSON.parse(jsonContent));
    });

    it('maintains data integrity through round-trip', async () => {
      const testCases = [
        { name: 'small text', content: smallContent, format: 'text' as const },
        { name: 'large text', content: largeContent, format: 'text' as const },
        { name: 'JSON', content: jsonContent, format: 'tiptap' as const },
        { name: 'HTML', content: '<div><p>Hello</p></div>'.repeat(100), format: 'html' as const },
        { name: 'unicode', content: '日本語 العربية 🎉'.repeat(100), format: 'text' as const },
      ];

      for (const { name, content, format } of testCases) {
        const result = await writePageContent(content, format);
        const read = await readPageContent(result.ref);
        expect(read).toBe(content);
      }
    });

    it('throws for invalid content reference', async () => {
      await expect(readPageContent('invalid-ref')).rejects.toThrow('Invalid content reference');
    });

    it('throws for non-existent content', async () => {
      const fakeRef = 'a'.repeat(64);
      await expect(readPageContent(fakeRef)).rejects.toThrow();
    });
  });

  describe('isContentCompressed', () => {
    it('returns true for compressed content', async () => {
      const result = await writePageContent(largeContent, 'text');
      expect(result.compressed).toBe(true);

      const isCompressed = await isContentCompressed(result.ref);
      expect(isCompressed).toBe(true);
    });

    it('returns false for uncompressed content', async () => {
      const result = await writePageContent(smallContent, 'text', { compress: false });
      expect(result.compressed).toBe(false);

      const isCompressed = await isContentCompressed(result.ref);
      expect(isCompressed).toBe(false);
    });

    it('throws for invalid reference', async () => {
      await expect(isContentCompressed('invalid-ref')).rejects.toThrow('Invalid content reference');
    });
  });

  describe('getContentMetadata', () => {
    it('returns metadata for compressed content', async () => {
      const result = await writePageContent(largeContent, 'text');
      const metadata = await getContentMetadata(result.ref);

      expect(metadata.compressed).toBe(true);
      expect(metadata.storedSize).toBe(result.storedSize);
    });

    it('returns metadata for uncompressed content', async () => {
      const result = await writePageContent(smallContent, 'text', { compress: false });
      const metadata = await getContentMetadata(result.ref);

      expect(metadata.compressed).toBe(false);
      expect(metadata.storedSize).toBe(result.storedSize);
    });
  });

  describe('backward compatibility', () => {
    it('reads legacy uncompressed content without magic header', async () => {
      // Simulate legacy content written without compression
      const legacyContent = 'This is legacy content without compression header';
      const result = await writePageContent(legacyContent, 'text', { compress: false });

      // Read it back - should work even though it wasn't compressed
      const content = await readPageContent(result.ref);
      expect(content).toBe(legacyContent);
    });

    it('handles content that happens to start with PSCOMP but is not compressed', async () => {
      // Edge case: content that looks like it might have the magic header
      // but is actually just regular content starting with those characters
      // (less likely in real usage, but good to test)
      const edgeCaseContent = 'PSCOMPThis starts with the magic but is not compressed'.repeat(50);
      const result = await writePageContent(edgeCaseContent, 'text');

      // Since content is large enough, it will be compressed
      // The compressed format will have the proper magic header
      const content = await readPageContent(result.ref);
      expect(content).toBe(edgeCaseContent);
    });
  });

  describe('compression threshold', () => {
    it('exports COMPRESSION_THRESHOLD_BYTES', () => {
      expect(COMPRESSION_THRESHOLD_BYTES).toBe(1024);
    });

    it('does not compress content just below threshold', async () => {
      const belowThreshold = 'a'.repeat(COMPRESSION_THRESHOLD_BYTES - 1);
      const result = await writePageContent(belowThreshold, 'text');

      expect(result.compressed).toBe(false);
    });

    it('compresses content at threshold', async () => {
      const atThreshold = 'a'.repeat(COMPRESSION_THRESHOLD_BYTES);
      const result = await writePageContent(atThreshold, 'text');

      expect(result.compressed).toBe(true);
    });
  });

  describe('large document handling', () => {
    it('handles 1MB document', async () => {
      const oneMB = 'x'.repeat(1024 * 1024);
      const result = await writePageContent(oneMB, 'text');

      expect(result.compressed).toBe(true);
      expect(result.compressionRatio).toBeLessThan(0.1); // Highly repetitive

      const content = await readPageContent(result.ref);
      expect(content).toBe(oneMB);
    });

    it('handles realistic 100KB JSON document', async () => {
      const largeDoc = JSON.stringify({
        type: 'doc',
        content: Array.from({ length: 1000 }, (_, i) => ({
          type: 'paragraph',
          attrs: { id: `para-${i}` },
          content: [
            { type: 'text', text: `This is paragraph ${i}. ` },
            { type: 'text', marks: [{ type: 'bold' }], text: 'Bold text. ' },
            { type: 'text', marks: [{ type: 'italic' }], text: 'Italic text. ' },
          ],
        })),
      });

      const result = await writePageContent(largeDoc, 'tiptap');

      expect(result.compressed).toBe(true);
      expect(result.size).toBeGreaterThan(100 * 1024);

      const content = await readPageContent(result.ref);
      expect(content).toBe(largeDoc);
      expect(JSON.parse(content)).toEqual(JSON.parse(largeDoc));
    });
  });

  describe('error handling', () => {
    it('throws for invalid format with invalid ref on read', async () => {
      await expect(readPageContent('not-a-valid-hex-ref')).rejects.toThrow('Invalid content reference');
    });

    it('handles concurrent writes to same content', async () => {
      // Multiple concurrent writes of same content should succeed
      const writes = Array.from({ length: 5 }, () =>
        writePageContent(largeContent, 'text')
      );

      const results = await Promise.all(writes);

      // All should succeed with same ref
      const refs = results.map(r => r.ref);
      expect(new Set(refs).size).toBe(1);
    });
  });
});
