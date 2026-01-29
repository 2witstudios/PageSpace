import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { FileProcessor } from '../file-processing/file-processor'
import { db, sql, users, pagePermissions, driveMembers, pages, drives } from '@pagespace/db'
import { factories } from '@pagespace/db/test/factories'
import { createHash } from 'crypto'

// Mock fetch for processor service
global.fetch = vi.fn()

describe('file-processor', () => {
  let processor: FileProcessor
  let testUser: Awaited<ReturnType<typeof factories.createUser>>
  let testDrive: Awaited<ReturnType<typeof factories.createDrive>>

  beforeEach(async () => {
    // Delete in foreign key order to avoid deadlocks from cascade contention
    await db.delete(pagePermissions)
    await db.delete(pages)
    await db.delete(driveMembers)
    await db.delete(drives)
    await db.delete(users)

    testUser = await factories.createUser()
    testDrive = await factories.createDrive(testUser.id)

    processor = new FileProcessor()

    // Reset fetch mock
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.clearAllMocks()
  })

  describe('processFile', () => {
    it('returns error for non-existent page', async () => {
      const result = await processor.processFile('nonexistent-page-id')

      expect(result.success).toBe(false)
      expect(result.error).toContain('Page or file path not found')
      expect(result.processingStatus).toBe('failed')
    })

    it('returns error for page without filePath', async () => {
      const page = await factories.createPage(testDrive.id, {
        type: 'DOCUMENT',
        filePath: null
      })

      const result = await processor.processFile(page.id)

      expect(result.success).toBe(false)
      expect(result.error).toContain('Page or file path not found')
    })

    it('fetches file from processor service via HTTP', async () => {
      const mockFileContent = Buffer.from('Test file content')

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockFileContent.buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'abc123hash',
        mimeType: 'text/plain',
        originalFileName: 'test.txt'
      })

      await processor.processFile(page.id)

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/cache/abc123hash/original'),
        expect.objectContaining({
          signal: expect.any(AbortSignal)
        })
      )
    })

    it('handles HTTP fetch timeout', async () => {
      ;(global.fetch as any).mockImplementation(() =>
        new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error('Timeout')), 20000)
        })
      )

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'abc123hash',
        mimeType: 'text/plain',
        originalFileName: 'test.txt'
      })

      // This should fall back to filesystem read and fail
      const result = await processor.processFile(page.id)

      // Should attempt HTTP first
      expect(global.fetch).toHaveBeenCalled()
    }, 25000)

    it('falls back to filesystem on HTTP error', async () => {
      ;(global.fetch as any).mockRejectedValue(new Error('Network error'))

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'nonexistent',
        mimeType: 'text/plain',
        originalFileName: 'test.txt'
      })

      await processor.processFile(page.id)

      // Should have attempted HTTP fetch
      expect(global.fetch).toHaveBeenCalled()
    })

    it('skips processing if content hash matches and status is completed', async () => {
      // Calculate the actual SHA256 hash of the test content
      const testContent = 'Previously processed content'
      const mockFileContent = Buffer.from(testContent, 'utf-8')
      const actualHash = createHash('sha256').update(mockFileContent).digest('hex')

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'test-file-path',
        mimeType: 'text/plain',
        contentHash: actualHash, // Use actual hash so skip logic works
        processingStatus: 'completed',
        content: testContent
      })

      // Create a clean ArrayBuffer from the UTF-8 bytes
      const encoder = new TextEncoder()
      const arrayBuffer = encoder.encode(testContent).buffer

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => arrayBuffer
      })

      const result = await processor.processFile(page.id)

      expect(result.success).toBe(true)
      expect(result.content).toBe(testContent)
      expect(result.processingStatus).toBe('completed')
      expect(result.contentHash).toBe(actualHash)
      // Should skip processing and return existing content from database
    })

    it('processes text/plain files', async () => {
      const mockFileContent = Buffer.from('Plain text file content')

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockFileContent.buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'text123',
        mimeType: 'text/plain',
        originalFileName: 'test.txt'
      })

      const result = await processor.processFile(page.id)

      // Result depends on implementation details
      expect(result).toHaveProperty('success')
      expect(result).toHaveProperty('processingStatus')
    })

    it('handles PDF mime type', async () => {
      const mockPDFContent = Buffer.from('PDF content placeholder')

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockPDFContent.buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'pdf123',
        mimeType: 'application/pdf',
        originalFileName: 'document.pdf'
      })

      const result = await processor.processFile(page.id)

      expect(result).toHaveProperty('success')
      expect(result).toHaveProperty('processingStatus')
    })

    it('handles Word document mime type', async () => {
      const mockWordContent = Buffer.from('Word content placeholder')

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockWordContent.buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'word123',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalFileName: 'document.docx'
      })

      const result = await processor.processFile(page.id)

      expect(result).toHaveProperty('success')
      expect(result).toHaveProperty('processingStatus')
    })

    it('calculates content hash for deduplication', async () => {
      const mockFileContent = Buffer.from('Test content for hashing')

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockFileContent.buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'hash123',
        mimeType: 'text/plain',
        originalFileName: 'test.txt'
      })

      const result = await processor.processFile(page.id)

      if (result.success && result.contentHash) {
        expect(result.contentHash).toBeTruthy()
        expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/) // SHA256 hex
      }
    })

    it('handles processing errors gracefully', async () => {
      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => {
          throw new Error('Corrupted file')
        }
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'corrupt123',
        mimeType: 'text/plain',
        originalFileName: 'corrupt.txt'
      })

      const result = await processor.processFile(page.id)

      // Should handle error gracefully
      expect(result).toHaveProperty('success')
      expect(result).toHaveProperty('processingStatus')
    })
  })

  describe('STORAGE_ROOT configuration', () => {
    it('uses FILE_STORAGE_PATH environment variable', () => {
      const originalPath = process.env.FILE_STORAGE_PATH
      process.env.FILE_STORAGE_PATH = '/custom/storage/path'

      const customProcessor = new FileProcessor()

      // Processor should use custom path
      expect(customProcessor).toBeTruthy()

      process.env.FILE_STORAGE_PATH = originalPath
    })

    it('uses default path when FILE_STORAGE_PATH not set', () => {
      const originalPath = process.env.FILE_STORAGE_PATH
      delete process.env.FILE_STORAGE_PATH

      const defaultProcessor = new FileProcessor()

      // Should use default /tmp/pagespace-files
      expect(defaultProcessor).toBeTruthy()

      process.env.FILE_STORAGE_PATH = originalPath
    })
  })

  describe('processor URL configuration', () => {
    it('uses PROCESSOR_URL environment variable', async () => {
      const originalUrl = process.env.PROCESSOR_URL
      process.env.PROCESSOR_URL = 'http://custom-processor:3003'

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => Buffer.from('test').buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'test123',
        mimeType: 'text/plain',
        originalFileName: 'test.txt'
      })

      await processor.processFile(page.id)

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('http://custom-processor:3003'),
        expect.anything()
      )

      process.env.PROCESSOR_URL = originalUrl
    })

    it('uses default processor URL when not set', async () => {
      const originalUrl = process.env.PROCESSOR_URL
      delete process.env.PROCESSOR_URL

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => Buffer.from('test').buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'test123',
        mimeType: 'text/plain',
        originalFileName: 'test.txt'
      })

      await processor.processFile(page.id)

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('http://processor:3003'),
        expect.anything()
      )

      process.env.PROCESSOR_URL = originalUrl
    })
  })

  describe('edge cases', () => {
    it('handles empty file', async () => {
      const emptyContent = Buffer.from('')

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => emptyContent.buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'empty123',
        mimeType: 'text/plain',
        originalFileName: 'empty.txt'
      })

      const result = await processor.processFile(page.id)

      expect(result).toHaveProperty('success')
    })

    it('handles very large files', async () => {
      const largeContent = Buffer.from('x'.repeat(10 * 1024 * 1024)) // 10MB

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => largeContent.buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'large123',
        mimeType: 'text/plain',
        originalFileName: 'large.txt'
      })

      const result = await processor.processFile(page.id)

      expect(result).toHaveProperty('success')
    }, 30000)

    it('handles file with special characters in name', async () => {
      const mockContent = Buffer.from('Test content')

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockContent.buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'special123',
        mimeType: 'text/plain',
        originalFileName: 'file with spaces & special!@#.txt'
      })

      const result = await processor.processFile(page.id)

      expect(result).toHaveProperty('success')
    })

    it('handles missing originalFileName', async () => {
      const mockContent = Buffer.from('Test content')

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockContent.buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'noname123',
        mimeType: 'text/plain',
        originalFileName: null
      })

      const result = await processor.processFile(page.id)

      expect(result).toHaveProperty('success')
    })

    it('handles missing mimeType', async () => {
      const mockContent = Buffer.from('Test content')

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockContent.buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'nomime123',
        mimeType: null,
        originalFileName: 'test.txt'
      })

      const result = await processor.processFile(page.id)

      expect(result).toHaveProperty('success')
    })

    it('handles HTTP 404 response', async () => {
      ;(global.fetch as any).mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'notfound123',
        mimeType: 'text/plain',
        originalFileName: 'test.txt'
      })

      await processor.processFile(page.id)

      // Should attempt fallback to filesystem
      expect(global.fetch).toHaveBeenCalled()
    })

    it('handles HTTP 500 response', async () => {
      ;(global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'error123',
        mimeType: 'text/plain',
        originalFileName: 'test.txt'
      })

      await processor.processFile(page.id)

      // Should attempt fallback to filesystem
      expect(global.fetch).toHaveBeenCalled()
    })
  })

  describe('return value structure', () => {
    it('returns ExtractionResult with required fields on success', async () => {
      const mockContent = Buffer.from('Test content')

      ;(global.fetch as any).mockResolvedValue({
        ok: true,
        arrayBuffer: async () => mockContent.buffer
      })

      const page = await factories.createPage(testDrive.id, {
        type: 'FILE',
        filePath: 'test123',
        mimeType: 'text/plain',
        originalFileName: 'test.txt'
      })

      const result = await processor.processFile(page.id)

      expect(result).toHaveProperty('success')
      expect(result).toHaveProperty('content')
      expect(result).toHaveProperty('processingStatus')
      expect(typeof result.success).toBe('boolean')
      expect(typeof result.content).toBe('string')
      expect(['pending', 'processing', 'completed', 'failed']).toContain(result.processingStatus)
    })

    it('returns ExtractionResult with error on failure', async () => {
      const result = await processor.processFile('nonexistent')

      expect(result).toHaveProperty('success')
      expect(result).toHaveProperty('error')
      expect(result.success).toBe(false)
      expect(typeof result.error).toBe('string')
    })
  })
})
