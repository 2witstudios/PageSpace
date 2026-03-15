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

// Mock content-other to keep tests self-contained
vi.mock('../content-other', () => ({
  AI_PRIVACY: 'AI privacy content',
  SHARING_PERMISSIONS: 'Sharing permissions content',
  REALTIME_COLLABORATION: 'Realtime collaboration content',
  TROUBLESHOOTING: 'Troubleshooting content',
}));

import { getReferenceSeedTemplate } from '../seed-template';
import type { SeedNodeTemplate } from '../seed-types';

describe('seed-template', () => {
  describe('getReferenceSeedTemplate', () => {
    it('is defined and is a function', () => {
      expect(getReferenceSeedTemplate).toBeDefined();
      expect(typeof getReferenceSeedTemplate).toBe('function');
    });

    it('returns a SeedNodeTemplate object', () => {
      const result = getReferenceSeedTemplate();
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('returns a FOLDER node titled Reference', () => {
      const result = getReferenceSeedTemplate();
      expect(result.title).toBe('Reference');
      expect(result.type).toBe('FOLDER');
    });

    it('has a children array with content', () => {
      const result = getReferenceSeedTemplate();
      expect(Array.isArray(result.children)).toBe(true);
      expect(result.children!.length).toBeGreaterThan(0);
    });

    it('has exactly 4 child pages', () => {
      const result = getReferenceSeedTemplate();
      expect(result.children!.length).toBe(4);
    });

    it('first child is Page Types Overview document', () => {
      const result = getReferenceSeedTemplate();
      const firstChild = result.children![0] as SeedNodeTemplate;
      expect(firstChild.title).toBe('Page Types Overview');
      expect(firstChild.type).toBe('DOCUMENT');
    });

    it('Page Types Overview has non-empty content', () => {
      const result = getReferenceSeedTemplate();
      const firstChild = result.children![0] as SeedNodeTemplate;
      expect(firstChild.content).toBeDefined();
      expect(firstChild.content!.length).toBeGreaterThan(0);
    });

    it('Page Types Overview content includes guide sections', () => {
      const result = getReferenceSeedTemplate();
      const firstChild = result.children![0] as SeedNodeTemplate;
      expect(firstChild.content).toContain('Folders guide content');
      expect(firstChild.content).toContain('Documents guide content');
    });

    it('second child is AI & Agents document', () => {
      const result = getReferenceSeedTemplate();
      const secondChild = result.children![1] as SeedNodeTemplate;
      expect(secondChild.title).toBe('AI & Agents');
      expect(secondChild.type).toBe('DOCUMENT');
    });

    it('AI & Agents document has non-empty content', () => {
      const result = getReferenceSeedTemplate();
      const secondChild = result.children![1] as SeedNodeTemplate;
      expect(secondChild.content).toBeDefined();
      expect(secondChild.content!.length).toBeGreaterThan(0);
    });

    it('AI & Agents content contains AI privacy info', () => {
      const result = getReferenceSeedTemplate();
      const secondChild = result.children![1] as SeedNodeTemplate;
      expect(secondChild.content).toContain('AI privacy content');
    });

    it('third child is Sharing & Collaboration document', () => {
      const result = getReferenceSeedTemplate();
      const thirdChild = result.children![2] as SeedNodeTemplate;
      expect(thirdChild.title).toBe('Sharing & Collaboration');
      expect(thirdChild.type).toBe('DOCUMENT');
    });

    it('Sharing & Collaboration content includes both sharing and realtime info', () => {
      const result = getReferenceSeedTemplate();
      const thirdChild = result.children![2] as SeedNodeTemplate;
      expect(thirdChild.content).toContain('Sharing permissions content');
      expect(thirdChild.content).toContain('Realtime collaboration content');
    });

    it('fourth child is Troubleshooting document', () => {
      const result = getReferenceSeedTemplate();
      const fourthChild = result.children![3] as SeedNodeTemplate;
      expect(fourthChild.title).toBe('Troubleshooting');
      expect(fourthChild.type).toBe('DOCUMENT');
      expect(fourthChild.content).toBe('Troubleshooting content');
    });

    it('no child has a taskList property', () => {
      const result = getReferenceSeedTemplate();
      result.children!.forEach((child) => {
        expect((child as SeedNodeTemplate).taskList).toBeUndefined();
      });
    });

    it('the top-level Reference node has no taskList', () => {
      const result = getReferenceSeedTemplate();
      expect(result.taskList).toBeUndefined();
    });

    it('returns a new object on each call (not a singleton)', () => {
      const result1 = getReferenceSeedTemplate();
      const result2 = getReferenceSeedTemplate();
      // Same structure but different object references
      expect(result1.title).toBe(result2.title);
    });

    it('all child types are DOCUMENT', () => {
      const result = getReferenceSeedTemplate();
      result.children!.forEach((child) => {
        expect((child as SeedNodeTemplate).type).toBe('DOCUMENT');
      });
    });
  });
});
