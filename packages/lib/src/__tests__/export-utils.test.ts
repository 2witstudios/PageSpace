import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock html-to-docx
vi.mock('html-to-docx', () => ({
  default: vi.fn(),
}));

// Mock xlsx
vi.mock('xlsx', () => {
  const mockWorksheet: Record<string, unknown> = {};
  const mockWorkbook: Record<string, unknown> = {
    SheetNames: [],
    Sheets: {},
  };

  return {
    utils: {
      book_new: vi.fn(() => ({ ...mockWorkbook })),
      aoa_to_sheet: vi.fn(() => ({ ...mockWorksheet })),
      book_append_sheet: vi.fn(),
    },
    write: vi.fn(() => new Uint8Array([0x50, 0x4b, 0x03, 0x04])),
  };
});

import { generateDOCX, sanitizeFilename, generateCSV, generateExcel } from '../content/export-utils';
import HTMLtoDOCX from 'html-to-docx';
import * as XLSX from 'xlsx';

describe('export-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateDOCX', () => {
    it('converts HTML to DOCX when result is an ArrayBuffer', async () => {
      const mockBuffer = new ArrayBuffer(8);
      (HTMLtoDOCX as ReturnType<typeof vi.fn>).mockResolvedValue(mockBuffer);

      const result = await generateDOCX('<p>Hello</p>', 'Test Doc');

      expect(result).toBeInstanceOf(Buffer);
      expect(HTMLtoDOCX).toHaveBeenCalledWith('<p>Hello</p>', null, {
        table: { row: { cantSplit: true } },
        footer: true,
        pageNumber: true,
        title: 'Test Doc',
      });
    });

    it('converts HTML to DOCX when result is a Blob', async () => {
      const mockBlob = new Blob(['docx content'], { type: 'application/octet-stream' });
      (HTMLtoDOCX as ReturnType<typeof vi.fn>).mockResolvedValue(mockBlob);

      const result = await generateDOCX('<p>Hello</p>', 'Test Doc');

      expect(result).toBeInstanceOf(Buffer);
    });

    it('returns result directly if already a Buffer-like type', async () => {
      const bufferData = Buffer.from('some data');
      (HTMLtoDOCX as ReturnType<typeof vi.fn>).mockResolvedValue(bufferData);

      const result = await generateDOCX('<h1>Title</h1>', 'My Title');

      expect(result).toBeInstanceOf(Buffer);
    });

    it('throws an error when html-to-docx fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (HTMLtoDOCX as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('conversion failed'));

      await expect(generateDOCX('<p>bad</p>', 'Fail')).rejects.toThrow('Failed to generate DOCX');
      expect(consoleSpy).toHaveBeenCalledWith('Error generating DOCX:', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });

  describe('sanitizeFilename', () => {
    it('removes invalid characters', () => {
      expect(sanitizeFilename('My File!@#$%.txt')).toBe('my_filetxt');
    });

    it('replaces spaces with underscores', () => {
      expect(sanitizeFilename('My Document')).toBe('my_document');
    });

    it('collapses multiple underscores', () => {
      expect(sanitizeFilename('My___File')).toBe('my_file');
    });

    it('removes leading and trailing underscores', () => {
      expect(sanitizeFilename('_My File_')).toBe('my_file');
    });

    it('converts to lowercase', () => {
      expect(sanitizeFilename('MyFileName')).toBe('myfilename');
    });

    it('handles already clean filenames', () => {
      expect(sanitizeFilename('clean-file-name')).toBe('clean-file-name');
    });

    it('handles filenames with only invalid characters', () => {
      expect(sanitizeFilename('!@#$%')).toBe('');
    });

    it('preserves hyphens', () => {
      expect(sanitizeFilename('my-file-name')).toBe('my-file-name');
    });

    it('handles filenames with numbers', () => {
      expect(sanitizeFilename('File 123')).toBe('file_123');
    });

    it('handles multiple spaces', () => {
      expect(sanitizeFilename('My   File   Name')).toBe('my_file_name');
    });
  });

  describe('generateCSV', () => {
    it('returns empty string for empty data', () => {
      expect(generateCSV([])).toBe('');
    });

    it('generates CSV from basic data', () => {
      const data = [
        ['Name', 'Age'],
        ['Alice', '30'],
        ['Bob', '25'],
      ];

      const result = generateCSV(data);

      expect(result).toBe('Name,Age\nAlice,30\nBob,25');
    });

    it('escapes fields containing commas', () => {
      const data = [['Name', 'Location'], ['Alice', 'New York, NY']];

      const result = generateCSV(data);

      expect(result).toBe('Name,Location\nAlice,"New York, NY"');
    });

    it('escapes fields containing double quotes', () => {
      const data = [['Name', 'Quote'], ['Alice', 'She said "hello"']];

      const result = generateCSV(data);

      expect(result).toBe('Name,Quote\nAlice,"She said ""hello"""');
    });

    it('escapes fields containing newlines', () => {
      const data = [['Name', 'Bio'], ['Alice', 'Line 1\nLine 2']];

      const result = generateCSV(data);

      expect(result).toBe('Name,Bio\nAlice,"Line 1\nLine 2"');
    });

    it('escapes fields containing carriage returns', () => {
      const data = [['Name', 'Notes'], ['Bob', 'Line 1\rLine 2']];

      const result = generateCSV(data);

      expect(result).toBe('Name,Notes\nBob,"Line 1\rLine 2"');
    });

    it('handles single row', () => {
      const data = [['A', 'B', 'C']];

      const result = generateCSV(data);

      expect(result).toBe('A,B,C');
    });

    it('handles single cell', () => {
      const data = [['Hello']];

      const result = generateCSV(data);

      expect(result).toBe('Hello');
    });

    it('leaves plain fields unescaped', () => {
      const data = [['simple', 'text', 'here']];

      const result = generateCSV(data);

      expect(result).toBe('simple,text,here');
    });
  });

  describe('generateExcel', () => {
    it('generates an Excel buffer from basic data', () => {
      const data = [
        ['Name', 'Age'],
        ['Alice', '30'],
      ];

      const result = generateExcel(data);

      expect(result).toBeInstanceOf(Buffer);
      expect(XLSX.utils.book_new).toHaveBeenCalledTimes(1);
      expect(XLSX.utils.aoa_to_sheet).toHaveBeenCalledWith(data);
      expect(XLSX.utils.book_append_sheet).toHaveBeenCalledTimes(1);
      expect(XLSX.write).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ type: 'buffer', bookType: 'xlsx', compression: true })
      );
    });

    it('uses custom sheet name', () => {
      const data = [['A']];

      generateExcel(data, 'MySheet');

      expect(XLSX.utils.book_append_sheet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        'MySheet'
      );
    });

    it('uses default sheet name when not provided', () => {
      const data = [['A']];

      generateExcel(data);

      expect(XLSX.utils.book_append_sheet).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        'Sheet1'
      );
    });

    it('sets workbook properties when title is provided', () => {
      const data = [['A']];

      generateExcel(data, 'Sheet1', 'My Workbook');

      // The function sets Props on the workbook object
      const bookNewMock = XLSX.utils.book_new as ReturnType<typeof vi.fn>;
      const workbook = bookNewMock.mock.results[0].value;
      expect(workbook.Props).toBeDefined();
      expect(workbook.Props.Title).toBe('My Workbook');
      expect(workbook.Props.Author).toBe('PageSpace');
    });

    it('does not set workbook properties when title is not provided', () => {
      const data = [['A']];

      generateExcel(data);

      const bookNewMock = XLSX.utils.book_new as ReturnType<typeof vi.fn>;
      const workbook = bookNewMock.mock.results[0].value;
      expect(workbook.Props).toBeUndefined();
    });

    it('throws an error when XLSX operations fail', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (XLSX.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('write failed');
      });

      expect(() => generateExcel([['A']])).toThrow('Failed to generate Excel file');
      expect(consoleSpy).toHaveBeenCalledWith('Error generating Excel:', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });
});
