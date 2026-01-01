import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';

// Mock the database before importing the service
vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn().mockReturnThis(),
  },
  pageVersions: {
    id: 'id',
  },
}));

import { db } from '@pagespace/db';
import {
  createPageVersion,
  computePageStateHash,
  type CompressionMetadata,
  type CreatePageVersionInput,
} from '../services/page-version-service';

describe('page-version-service', () => {
  const testStoragePath = join(process.cwd(), 'test-storage-version-service');

  beforeEach(async () => {
    // Set up test storage path
    process.env.PAGE_CONTENT_STORAGE_PATH = testStoragePath;
    // Clean up any existing test storage
    try {
      await fs.rm(testStoragePath, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
    // Reset mocks
    vi.clearAllMocks();
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

  // Test content
  const smallContent = 'Hello, World!';
  const largeContent = 'a'.repeat(5000);
  const jsonContent = JSON.stringify({
    type: 'doc',
    content: Array.from({ length: 100 }, (_, i) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `This is paragraph ${i} with some content.` }],
    })),
  });

  const baseInput: CreatePageVersionInput = {
    pageId: 'test-page-id',
    driveId: 'test-drive-id',
    source: 'auto',
    content: smallContent,
    pageRevision: 1,
    stateHash: 'test-hash-12345',
  };

  describe('createPageVersion', () => {
    beforeEach(() => {
      // Set up mock chain for database insert
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'test-version-id' }]);
      const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });
    });

    it('returns compression metadata for small content (uncompressed)', async () => {
      const result = await createPageVersion({ ...baseInput, content: smallContent });

      expect(result.id).toBe('test-version-id');
      expect(result.contentRef).toMatch(/^[a-f0-9]{64}$/i);
      expect(result.contentSize).toBe(Buffer.byteLength(smallContent, 'utf8'));
      expect(result.compressed).toBe(false);
      expect(result.storedSize).toBe(result.contentSize);
      expect(result.compressionRatio).toBe(1);
    });

    it('returns compression metadata for large content (compressed)', async () => {
      const result = await createPageVersion({ ...baseInput, content: largeContent });

      expect(result.id).toBe('test-version-id');
      expect(result.contentRef).toMatch(/^[a-f0-9]{64}$/i);
      expect(result.contentSize).toBe(Buffer.byteLength(largeContent, 'utf8'));
      expect(result.compressed).toBe(true);
      expect(result.storedSize).toBeLessThan(result.contentSize);
      expect(result.compressionRatio).toBeLessThan(1);
    });

    it('returns compression metadata for JSON content', async () => {
      const result = await createPageVersion({
        ...baseInput,
        content: jsonContent,
        contentFormat: 'tiptap',
      });

      expect(result.compressed).toBe(true);
      expect(result.compressionRatio).toBeLessThan(0.5);
    });

    it('stores compression metadata in database metadata field', async () => {
      let capturedValues: Record<string, unknown> | null = null;
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'test-version-id' }]);
      const mockValues = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedValues = values;
        return { returning: mockReturning };
      });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

      await createPageVersion({ ...baseInput, content: largeContent });

      expect(capturedValues).not.toBeNull();
      expect(capturedValues!.metadata).toBeDefined();

      const metadata = capturedValues!.metadata as { compression: CompressionMetadata };
      expect(metadata.compression).toBeDefined();
      expect(metadata.compression.compressed).toBe(true);
      expect(metadata.compression.originalSize).toBe(Buffer.byteLength(largeContent, 'utf8'));
      expect(metadata.compression.storedSize).toBeLessThan(metadata.compression.originalSize);
      expect(metadata.compression.compressionRatio).toBeLessThan(1);
    });

    it('merges compression metadata with existing metadata', async () => {
      let capturedValues: Record<string, unknown> | null = null;
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'test-version-id' }]);
      const mockValues = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedValues = values;
        return { returning: mockReturning };
      });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

      const existingMetadata = {
        customField: 'custom-value',
        anotherField: 123,
      };

      await createPageVersion({
        ...baseInput,
        content: largeContent,
        metadata: existingMetadata,
      });

      const metadata = capturedValues!.metadata as Record<string, unknown>;
      expect(metadata.customField).toBe('custom-value');
      expect(metadata.anotherField).toBe(123);
      expect(metadata.compression).toBeDefined();
    });

    it('stores correct contentSize (original size, not compressed)', async () => {
      let capturedValues: Record<string, unknown> | null = null;
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'test-version-id' }]);
      const mockValues = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedValues = values;
        return { returning: mockReturning };
      });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

      await createPageVersion({ ...baseInput, content: largeContent });

      // contentSize in database should be original size, not compressed
      expect(capturedValues!.contentSize).toBe(Buffer.byteLength(largeContent, 'utf8'));
    });

    it('detects content format when not specified', async () => {
      let capturedValues: Record<string, unknown> | null = null;
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'test-version-id' }]);
      const mockValues = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedValues = values;
        return { returning: mockReturning };
      });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

      // HTML content
      await createPageVersion({
        ...baseInput,
        content: '<html><body><p>Hello</p></body></html>',
      });

      expect(capturedValues!.contentFormat).toBe('html');
    });

    it('uses specified content format', async () => {
      let capturedValues: Record<string, unknown> | null = null;
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'test-version-id' }]);
      const mockValues = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedValues = values;
        return { returning: mockReturning };
      });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

      await createPageVersion({
        ...baseInput,
        content: jsonContent,
        contentFormat: 'tiptap',
      });

      expect(capturedValues!.contentFormat).toBe('tiptap');
    });

    it('uses transaction when provided', async () => {
      const mockTx = {
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'tx-version-id' }]),
          }),
        }),
      };

      const result = await createPageVersion(baseInput, { tx: mockTx as unknown as typeof db });

      expect(result.id).toBe('tx-version-id');
      expect(mockTx.insert).toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('includes all required fields in database insert', async () => {
      let capturedValues: Record<string, unknown> | null = null;
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'test-version-id' }]);
      const mockValues = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedValues = values;
        return { returning: mockReturning };
      });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

      await createPageVersion({
        pageId: 'page-123',
        driveId: 'drive-456',
        createdBy: 'user-789',
        source: 'manual',
        label: 'Test Label',
        reason: 'Test Reason',
        content: largeContent,
        pageRevision: 5,
        stateHash: 'hash-abc',
        changeGroupId: 'group-1',
        changeGroupType: 'bulk',
      });

      expect(capturedValues!.pageId).toBe('page-123');
      expect(capturedValues!.driveId).toBe('drive-456');
      expect(capturedValues!.createdBy).toBe('user-789');
      expect(capturedValues!.source).toBe('manual');
      expect(capturedValues!.label).toBe('Test Label');
      expect(capturedValues!.reason).toBe('Test Reason');
      expect(capturedValues!.pageRevision).toBe(5);
      expect(capturedValues!.stateHash).toBe('hash-abc');
      expect(capturedValues!.changeGroupId).toBe('group-1');
      expect(capturedValues!.changeGroupType).toBe('bulk');
    });

    it('handles null createdBy', async () => {
      let capturedValues: Record<string, unknown> | null = null;
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'test-version-id' }]);
      const mockValues = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedValues = values;
        return { returning: mockReturning };
      });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

      await createPageVersion({
        ...baseInput,
        createdBy: null,
      });

      expect(capturedValues!.createdBy).toBeNull();
    });

    it('handles undefined createdBy', async () => {
      let capturedValues: Record<string, unknown> | null = null;
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'test-version-id' }]);
      const mockValues = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedValues = values;
        return { returning: mockReturning };
      });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

      // createdBy not specified
      await createPageVersion(baseInput);

      expect(capturedValues!.createdBy).toBeNull();
    });
  });

  describe('computePageStateHash', () => {
    it('computes consistent hash for same input', () => {
      const input = {
        title: 'Test Page',
        contentRef: 'abc123',
        parentId: null,
        position: 0,
        isTrashed: false,
        type: 'document',
        driveId: 'drive-1',
      };

      const hash1 = computePageStateHash(input);
      const hash2 = computePageStateHash(input);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/i);
    });

    it('produces different hash for different input', () => {
      const input1 = {
        title: 'Test Page',
        contentRef: 'abc123',
        parentId: null,
        position: 0,
        isTrashed: false,
        type: 'document',
        driveId: 'drive-1',
      };

      const input2 = {
        ...input1,
        title: 'Different Title',
      };

      const hash1 = computePageStateHash(input1);
      const hash2 = computePageStateHash(input2);

      expect(hash1).not.toBe(hash2);
    });

    it('includes all fields in hash computation', () => {
      const base = {
        title: 'Test',
        contentRef: 'ref',
        parentId: 'parent',
        position: 1,
        isTrashed: false,
        type: 'doc',
        driveId: 'drive',
      };

      // Each field change should produce a different hash
      const hashes = [
        computePageStateHash(base),
        computePageStateHash({ ...base, title: 'Different' }),
        computePageStateHash({ ...base, contentRef: 'different' }),
        computePageStateHash({ ...base, parentId: 'different' }),
        computePageStateHash({ ...base, position: 2 }),
        computePageStateHash({ ...base, isTrashed: true }),
        computePageStateHash({ ...base, type: 'different' }),
        computePageStateHash({ ...base, driveId: 'different' }),
      ];

      const uniqueHashes = new Set(hashes);
      expect(uniqueHashes.size).toBe(hashes.length);
    });

    it('includes optional fields in hash computation', () => {
      const base = {
        title: 'Test',
        contentRef: 'ref',
        parentId: null,
        position: 1,
        isTrashed: false,
        type: 'doc',
        driveId: 'drive',
      };

      const withOptional = {
        ...base,
        aiProvider: 'openai',
        aiModel: 'gpt-4',
        systemPrompt: 'You are a helpful assistant',
      };

      const hash1 = computePageStateHash(base);
      const hash2 = computePageStateHash(withOptional);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('compression metadata structure', () => {
    it('has correct structure for uncompressed content', async () => {
      let capturedMetadata: { compression: CompressionMetadata } | null = null;
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'test-version-id' }]);
      const mockValues = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedMetadata = values.metadata as { compression: CompressionMetadata };
        return { returning: mockReturning };
      });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

      await createPageVersion({ ...baseInput, content: smallContent });

      expect(capturedMetadata!.compression).toEqual({
        compressed: false,
        originalSize: Buffer.byteLength(smallContent, 'utf8'),
        storedSize: Buffer.byteLength(smallContent, 'utf8'),
        compressionRatio: 1,
      });
    });

    it('has correct structure for compressed content', async () => {
      let capturedMetadata: { compression: CompressionMetadata } | null = null;
      const mockReturning = vi.fn().mockResolvedValue([{ id: 'test-version-id' }]);
      const mockValues = vi.fn().mockImplementation((values: Record<string, unknown>) => {
        capturedMetadata = values.metadata as { compression: CompressionMetadata };
        return { returning: mockReturning };
      });
      (db.insert as ReturnType<typeof vi.fn>).mockReturnValue({ values: mockValues });

      await createPageVersion({ ...baseInput, content: largeContent });

      const compression = capturedMetadata!.compression;
      expect(compression.compressed).toBe(true);
      expect(compression.originalSize).toBe(Buffer.byteLength(largeContent, 'utf8'));
      expect(compression.storedSize).toBeLessThan(compression.originalSize);
      expect(compression.compressionRatio).toBeGreaterThan(0);
      expect(compression.compressionRatio).toBeLessThan(1);
    });
  });
});
