import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/lib', () => ({
  createEmptySheet: vi.fn(() => ({ cells: {} })),
  serializeSheetContent: vi.fn((sheet) => JSON.stringify(sheet)),
}));

import {
  FOLDERS_GUIDE,
  DOCUMENTS_GUIDE,
  SHEETS_GUIDE,
  FILES_GUIDE,
  TASK_LISTS_GUIDE,
  CANVAS_GUIDE,
  CHANNELS_GUIDE,
  AI_CHAT_GUIDE,
  buildBudgetSheetContent,
} from '../content-page-types';
import { createEmptySheet, serializeSheetContent } from '@pagespace/lib';

describe('content-page-types', () => {
  describe('guide constants', () => {
    it.each([
      ['FOLDERS_GUIDE', FOLDERS_GUIDE, 'Folders'],
      ['DOCUMENTS_GUIDE', DOCUMENTS_GUIDE, 'Documents'],
      ['SHEETS_GUIDE', SHEETS_GUIDE, 'Sheets'],
      ['FILES_GUIDE', FILES_GUIDE, 'Files'],
      ['TASK_LISTS_GUIDE', TASK_LISTS_GUIDE, 'Task Lists'],
      ['CANVAS_GUIDE', CANVAS_GUIDE, 'Canvas'],
      ['CHANNELS_GUIDE', CHANNELS_GUIDE, 'Channels'],
      ['AI_CHAT_GUIDE', AI_CHAT_GUIDE, 'AI Chat'],
    ])('%s should be a non-empty string containing %s', (_name, guide, keyword) => {
      expect(typeof guide).toBe('string');
      expect(guide.length).toBeGreaterThan(0);
      expect(guide).toContain(keyword);
    });

    it('should not have leading or trailing whitespace', () => {
      const guides = [FOLDERS_GUIDE, DOCUMENTS_GUIDE, SHEETS_GUIDE, FILES_GUIDE,
        TASK_LISTS_GUIDE, CANVAS_GUIDE, CHANNELS_GUIDE, AI_CHAT_GUIDE];
      for (const guide of guides) {
        expect(guide).toBe(guide.trim());
      }
    });
  });

  describe('buildBudgetSheetContent', () => {
    it('should call createEmptySheet with 20 rows and 8 cols', () => {
      buildBudgetSheetContent();
      expect(createEmptySheet).toHaveBeenCalledWith(20, 8);
    });

    it('should populate cells with budget data', () => {
      buildBudgetSheetContent();
      const sheet = vi.mocked(createEmptySheet).mock.results[0].value;
      expect(sheet.cells.A1).toBe('Item');
      expect(sheet.cells.B1).toBe('Cost');
      expect(sheet.cells.B6).toBe('=SUM(B2:B4)');
    });

    it('should call serializeSheetContent and return its result', () => {
      const result = buildBudgetSheetContent();
      expect(serializeSheetContent).toHaveBeenCalled();
      expect(typeof result).toBe('string');
    });
  });
});
