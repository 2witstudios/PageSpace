import { describe, expect, it } from 'vitest';
import { decideExtractionWrite, EXTRACTABLE_PAGE_TYPE } from '../extraction-write-guard';

describe('decideExtractionWrite', () => {
  it('given a FILE page, writes the extracted content', () => {
    expect(decideExtractionWrite({ pageType: 'FILE' })).toEqual({ action: 'write' });
  });

  it('given a page converted to DOCUMENT, keeps the bookkeeping but not the content', () => {
    expect(decideExtractionWrite({ pageType: 'DOCUMENT' })).toEqual({
      action: 'skip-content',
      pageType: 'DOCUMENT',
    });
  });

  it.each(['DOCUMENT', 'FOLDER', 'AI_CHAT', 'CHANNEL', 'DATABASE', 'SHEET', 'TASK_LIST', 'CANVAS'])(
    'given a %s page, refuses the content write',
    (pageType) => {
      expect(decideExtractionWrite({ pageType }).action).toBe('skip-content');
    },
  );

  it('given a page that no longer exists, writes nothing', () => {
    expect(decideExtractionWrite({ pageType: null })).toEqual({ action: 'skip-all' });
  });

  it('fences on exactly one page type', () => {
    expect(EXTRACTABLE_PAGE_TYPE).toBe('FILE');
  });
});
