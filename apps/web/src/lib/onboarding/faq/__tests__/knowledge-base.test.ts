import { describe, it, expect, vi } from 'vitest';

// Mock content-page-types to avoid @pagespace/lib dependency
vi.mock('../content-page-types', () => ({
  FOLDERS_GUIDE: 'Folders guide content',
  DOCUMENTS_GUIDE: 'Documents guide content',
  SHEETS_GUIDE: 'Sheets guide content',
  FILES_GUIDE: 'Files guide content',
  TASK_LISTS_GUIDE: 'Task lists guide content',
  CANVAS_GUIDE: 'Canvas guide content',
  CHANNELS_GUIDE: 'Channels guide content',
  AI_CHAT_GUIDE: 'AI chat guide content',
  buildBudgetSheetContent: vi.fn(() => '{}'),
}));

import { getFaqKnowledgeBaseDocuments } from '../knowledge-base';

describe('knowledge-base', () => {
  describe('getFaqKnowledgeBaseDocuments', () => {
    it('is defined and is a function', () => {
      expect(getFaqKnowledgeBaseDocuments).toBeDefined();
      expect(typeof getFaqKnowledgeBaseDocuments).toBe('function');
    });

    it('returns a non-empty readonly array', () => {
      const result = getFaqKnowledgeBaseDocuments();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });

    it('returns exactly 12 knowledge base documents', () => {
      const result = getFaqKnowledgeBaseDocuments();
      expect(result.length).toBe(12);
    });

    it('each document has a title and content property', () => {
      const result = getFaqKnowledgeBaseDocuments();
      result.forEach((doc) => {
        expect(doc).toHaveProperty('title');
        expect(doc).toHaveProperty('content');
        expect(typeof doc.title).toBe('string');
        expect(typeof doc.content).toBe('string');
      });
    });

    it('each document has a non-empty title', () => {
      const result = getFaqKnowledgeBaseDocuments();
      result.forEach((doc) => {
        expect(doc.title.length).toBeGreaterThan(0);
      });
    });

    it('each document has non-empty content', () => {
      const result = getFaqKnowledgeBaseDocuments();
      result.forEach((doc) => {
        expect(doc.content.length).toBeGreaterThan(0);
      });
    });

    it('includes a Folders guide document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const foldersDoc = result.find((doc) => doc.title === 'Folders (Guide)');
      expect(foldersDoc).toBeDefined();
      expect(foldersDoc!.content).toBe('Folders guide content');
    });

    it('includes a Documents guide document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const doc = result.find((d) => d.title === 'Documents (Guide)');
      expect(doc).toBeDefined();
    });

    it('includes a Sheets guide document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const doc = result.find((d) => d.title === 'Sheets (Guide)');
      expect(doc).toBeDefined();
    });

    it('includes a Files guide document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const doc = result.find((d) => d.title === 'Files (Guide)');
      expect(doc).toBeDefined();
    });

    it('includes a Task Lists guide document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const doc = result.find((d) => d.title === 'Task Lists (Guide)');
      expect(doc).toBeDefined();
    });

    it('includes a Canvas guide document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const doc = result.find((d) => d.title === 'Canvas (Guide)');
      expect(doc).toBeDefined();
    });

    it('includes a Channels guide document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const doc = result.find((d) => d.title === 'Channels (Guide)');
      expect(doc).toBeDefined();
    });

    it('includes an AI Chat guide document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const doc = result.find((d) => d.title === 'AI Chat (Guide)');
      expect(doc).toBeDefined();
    });

    it('includes AI & Privacy document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const doc = result.find((d) => d.title === 'AI & Privacy (FAQ)');
      expect(doc).toBeDefined();
    });

    it('includes Sharing & Permissions document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const doc = result.find((d) => d.title === 'Sharing & Permissions');
      expect(doc).toBeDefined();
    });

    it('includes Real-time Collaboration document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const doc = result.find((d) => d.title === 'Real-time Collaboration');
      expect(doc).toBeDefined();
    });

    it('includes Troubleshooting document', () => {
      const result = getFaqKnowledgeBaseDocuments();
      const doc = result.find((d) => d.title === 'Troubleshooting (FAQ)');
      expect(doc).toBeDefined();
    });

    it('returns the same structure on multiple calls', () => {
      const result1 = getFaqKnowledgeBaseDocuments();
      const result2 = getFaqKnowledgeBaseDocuments();
      expect(result1.length).toBe(result2.length);
      expect(result1.map((d) => d.title)).toEqual(result2.map((d) => d.title));
    });
  });
});
