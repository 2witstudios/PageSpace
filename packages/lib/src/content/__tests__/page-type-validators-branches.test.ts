import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PageType } from '../../utils/enums';

// Mock page-types.config to return configs with requiredFields and customValidation
vi.mock('../page-types.config', () => {
  const configs: Record<string, unknown> = {
    DOCUMENT: {
      type: 'DOCUMENT',
      displayName: 'Document',
      capabilities: {},
      apiValidation: {
        requiredFields: ['title', 'driveId'],
      },
    },
    FOLDER: {
      type: 'FOLDER',
      displayName: 'Folder',
      capabilities: {},
      apiValidation: {
        customValidation: (data: Record<string, unknown>) => {
          if (data.name && typeof data.name !== 'string') {
            return { valid: false, error: 'name must be a string' };
          }
          return { valid: true };
        },
      },
    },
    AI_CHAT: {
      type: 'AI_CHAT',
      displayName: 'AI Chat',
      capabilities: {},
    },
    FILE: {
      type: 'FILE',
      displayName: 'File',
      capabilities: {},
    },
    CHANNEL: {
      type: 'CHANNEL',
      displayName: 'Channel',
      capabilities: {},
    },
    CANVAS: {
      type: 'CANVAS',
      displayName: 'Canvas',
      capabilities: {},
    },
    SHEET: {
      type: 'SHEET',
      displayName: 'Sheet',
      capabilities: {},
    },
    TASK_LIST: {
      type: 'TASK_LIST',
      displayName: 'Task List',
      capabilities: {},
    },
    CODE: {
      type: 'CODE',
      displayName: 'Code',
      capabilities: {},
    },
  };

  return {
    PAGE_TYPE_CONFIGS: configs,
    getPageTypeConfig: (type: string) => configs[type] || configs.DOCUMENT,
    getPageTypeIconName: () => 'FileText',
    canPageTypeAcceptUploads: () => false,
    getDefaultContent: () => '',
    getPageTypeComponent: () => 'DocumentView',
    getLayoutViewType: () => 'document',
    isDocumentPage: (t: string) => t === 'DOCUMENT',
    isFilePage: (t: string) => t === 'FILE',
    isSheetPage: (t: string) => t === 'SHEET',
    supportsAI: () => false,
    supportsRealtime: () => false,
    canBeConverted: () => false,
    getPageTypeDisplayName: () => 'Document',
    getPageTypeDescription: () => '',
    getPageTypeEmoji: () => '',
    isFolderPage: (t: string) => t === 'FOLDER',
    isCanvasPage: (t: string) => t === 'CANVAS',
    isChannelPage: (t: string) => t === 'CHANNEL',
    isAIChatPage: (t: string) => t === 'AI_CHAT',
    isTaskListPage: (t: string) => t === 'TASK_LIST',
    isCodePage: (t: string) => t === 'CODE',
  };
});

import { validatePageCreation } from '../page-type-validators';

describe('validatePageCreation branch coverage', () => {
  describe('requiredFields validation (lines 69-74)', () => {
    it('should report missing required fields', () => {
      // DOCUMENT config now has requiredFields: ['title', 'driveId']
      const result = validatePageCreation(PageType.DOCUMENT, {});
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: title');
      expect(result.errors).toContain('Missing required field: driveId');
    });

    it('should pass when all required fields are present', () => {
      const result = validatePageCreation(PageType.DOCUMENT, {
        title: 'Test',
        driveId: 'drive-1',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should report only missing fields', () => {
      const result = validatePageCreation(PageType.DOCUMENT, {
        title: 'Test',
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBe('Missing required field: driveId');
    });
  });

  describe('customValidation (lines 132-136)', () => {
    it('should run custom validation and collect errors', () => {
      // FOLDER config now has customValidation
      const result = validatePageCreation(PageType.FOLDER, {
        name: 12345, // not a string
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('name must be a string');
    });

    it('should pass custom validation when data is valid', () => {
      const result = validatePageCreation(PageType.FOLDER, {
        name: 'Valid Name',
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });
});
