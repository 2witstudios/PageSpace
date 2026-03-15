import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock pdfjs-dist
vi.mock('pdfjs-dist', () => ({
  getDocument: vi.fn(),
}));

// Mock mammoth
vi.mock('mammoth', () => ({
  default: {
    extractRawText: vi.fn(),
  },
  extractRawText: vi.fn(),
}));

// Mock fs/promises
const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
  default: {
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
}));

// Mock content store
const mockGetOriginal = vi.fn();
const mockGetCachePath = vi.fn().mockResolvedValue('/cache/hash/text.jpg');

vi.mock('../../server', () => ({
  contentStore: {
    getOriginal: (...args: unknown[]) => mockGetOriginal(...args),
    getCachePath: (...args: unknown[]) => mockGetCachePath(...args),
  },
}));

import { extractText, needsTextExtraction } from '../text-extractor';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';

const VALID_HASH = 'a'.repeat(64);

describe('extractText', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOriginal.mockResolvedValue(Buffer.from('file-content'));
    mockGetCachePath.mockResolvedValue(`/cache/${VALID_HASH}/text.jpg`);
  });

  it('throws when original file not found', async () => {
    mockGetOriginal.mockResolvedValue(null);

    await expect(
      extractText({ contentHash: VALID_HASH, fileId: 'page-1', mimeType: 'application/pdf', originalName: 'test.pdf' })
    ).rejects.toThrow(`Original file not found: ${VALID_HASH}`);
  });

  it('extracts text from plain text file', async () => {
    const content = 'Hello, world!';
    mockGetOriginal.mockResolvedValue(Buffer.from(content));

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'text/plain',
      originalName: 'test.txt',
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe(content);
    expect(result.textLength).toBe(content.length);
  });

  it('extracts text from markdown file', async () => {
    const content = '# Hello\n\nThis is markdown.';
    mockGetOriginal.mockResolvedValue(Buffer.from(content));

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'text/markdown',
      originalName: 'test.md',
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe(content);
  });

  it('extracts text from CSV file', async () => {
    const content = 'a,b,c\n1,2,3';
    mockGetOriginal.mockResolvedValue(Buffer.from(content));

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'text/csv',
      originalName: 'data.csv',
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe(content);
  });

  it('extracts and formats JSON file', async () => {
    const jsonObj = { key: 'value', num: 42 };
    mockGetOriginal.mockResolvedValue(Buffer.from(JSON.stringify(jsonObj)));

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'application/json',
      originalName: 'data.json',
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain('"key"');
    expect(result.text).toContain('"value"');
  });

  it('returns failure for unsupported mime type', async () => {
    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'application/octet-stream',
      originalName: 'binary.bin',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unsupported file type');
  });

  it('extracts text from PDF', async () => {
    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({
        items: [{ str: 'Page 1 text' }, { str: ' more text' }],
      }),
    };
    const mockPdf = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue(mockPage),
      getMetadata: vi.fn().mockResolvedValue({
        info: { Title: 'Test PDF', Author: 'Test Author' },
      }),
    };
    (pdfjsLib.getDocument as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve(mockPdf),
    });

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'application/pdf',
      originalName: 'test.pdf',
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain('Page 1 text');
  });

  it('extracts text from multi-page PDF', async () => {
    const mockPage1 = {
      getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'Page 1' }] }),
    };
    const mockPage2 = {
      getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'Page 2' }] }),
    };
    const mockPdf = {
      numPages: 2,
      getPage: vi.fn().mockImplementation((n: number) =>
        n === 1 ? Promise.resolve(mockPage1) : Promise.resolve(mockPage2)
      ),
      getMetadata: vi.fn().mockResolvedValue({ info: null }),
    };
    (pdfjsLib.getDocument as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve(mockPdf),
    });

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'application/pdf',
      originalName: 'test.pdf',
    });

    expect(result.success).toBe(true);
    expect(result.text).toContain('Page 1');
    expect(result.text).toContain('Page 2');
  });

  it('handles PDF with null metadata info', async () => {
    const mockPage = {
      getTextContent: vi.fn().mockResolvedValue({ items: [{ str: 'text' }] }),
    };
    const mockPdf = {
      numPages: 1,
      getPage: vi.fn().mockResolvedValue(mockPage),
      getMetadata: vi.fn().mockResolvedValue({ info: null }),
    };
    (pdfjsLib.getDocument as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.resolve(mockPdf),
    });

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'application/pdf',
      originalName: 'test.pdf',
    });

    expect(result.success).toBe(true);
    expect(result.metadata?.title).toBe('');
  });

  it('extracts text from docx file', async () => {
    (mammoth.extractRawText as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: 'Extracted DOCX text',
      messages: [],
    });

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalName: 'doc.docx',
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Extracted DOCX text');
  });

  it('extracts text from old .doc format', async () => {
    (mammoth.extractRawText as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: 'Old Word document text',
      messages: [],
    });

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'application/msword',
      originalName: 'doc.doc',
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Old Word document text');
  });

  it('handles docx with extraction warnings', async () => {
    (mammoth.extractRawText as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: 'Text with warnings',
      messages: [{ type: 'warning', message: 'Some warning' }],
    });

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      originalName: 'doc.docx',
    });

    expect(result.success).toBe(true);
    expect(result.text).toBe('Text with warnings');
  });

  it('removes null bytes from extracted text', async () => {
    const contentWithNulls = 'Hello\0World\0';
    mockGetOriginal.mockResolvedValue(Buffer.from(contentWithNulls));

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'text/plain',
      originalName: 'test.txt',
    });

    expect(result.success).toBe(true);
    expect(result.text).not.toContain('\0');
    expect(result.text).toBe('HelloWorld');
  });

  it('throws when PDF processing fails', async () => {
    (pdfjsLib.getDocument as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      promise: Promise.reject(new Error('PDF parse error')),
    });

    await expect(
      extractText({
        contentHash: VALID_HASH,
        fileId: 'page-1',
        mimeType: 'application/pdf',
        originalName: 'bad.pdf',
      })
    ).rejects.toThrow('PDF parse error');
  });

  it('writes extracted text to cache', async () => {
    const content = 'Hello world';
    mockGetOriginal.mockResolvedValue(Buffer.from(content));

    await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'text/plain',
      originalName: 'test.txt',
    });

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining(VALID_HASH),
      expect.objectContaining({ recursive: true })
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('extracted-text.txt'),
      'Hello world'
    );
  });

  it('includes textLength in result', async () => {
    const content = 'Hello world test';
    mockGetOriginal.mockResolvedValue(Buffer.from(content));

    const result = await extractText({
      contentHash: VALID_HASH,
      fileId: 'page-1',
      mimeType: 'text/plain',
      originalName: 'test.txt',
    });

    expect(result.textLength).toBe(content.length);
  });
});

describe('needsTextExtraction', () => {
  it('returns true for application/pdf', () => {
    expect(needsTextExtraction('application/pdf')).toBe(true);
  });

  it('returns true for docx', () => {
    expect(needsTextExtraction('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
  });

  it('returns true for application/msword', () => {
    expect(needsTextExtraction('application/msword')).toBe(true);
  });

  it('returns true for text/plain', () => {
    expect(needsTextExtraction('text/plain')).toBe(true);
  });

  it('returns true for text/markdown', () => {
    expect(needsTextExtraction('text/markdown')).toBe(true);
  });

  it('returns true for text/csv', () => {
    expect(needsTextExtraction('text/csv')).toBe(true);
  });

  it('returns true for application/json', () => {
    expect(needsTextExtraction('application/json')).toBe(true);
  });

  it('returns false for image/jpeg', () => {
    expect(needsTextExtraction('image/jpeg')).toBe(false);
  });

  it('returns false for application/octet-stream', () => {
    expect(needsTextExtraction('application/octet-stream')).toBe(false);
  });

  it('returns false for unknown types', () => {
    expect(needsTextExtraction('video/mp4')).toBe(false);
  });
});
