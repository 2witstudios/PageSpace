/**
 * Tests for apps/web/src/lib/ai/tools/page-context-defaults.ts
 *
 * Covers the shared "default an omitted pageId tool argument" logic used by
 * read_page, replace_lines, rename_page, move_page, insert_content, and
 * edit_sheet_cells (page-read-tools.ts / page-write-tools.ts).
 */

import { describe, it, expect } from 'vitest';
import { resolveDefaultPageId, resolveOrThrowPageId } from '../page-context-defaults';
import type { ToolExecutionContext } from '../../core/types';

describe('resolveDefaultPageId', () => {
  it('prefers currentWorkingPage over locationContext.currentPage', () => {
    const context = {
      currentWorkingPage: { id: 'working-page', title: 'Working', type: 'DOCUMENT' },
      locationContext: { currentPage: { id: 'viewed-page', title: 'Viewed', type: 'DOCUMENT', path: '/p' } },
    } as ToolExecutionContext;
    expect(resolveDefaultPageId(context)).toBe('working-page');
  });

  it('falls back to locationContext.currentPage.id when currentWorkingPage is absent', () => {
    const context = {
      locationContext: { currentPage: { id: 'viewed-page', title: 'Viewed', type: 'DOCUMENT', path: '/p' } },
    } as ToolExecutionContext;
    expect(resolveDefaultPageId(context)).toBe('viewed-page');
  });

  it('returns undefined when neither is present', () => {
    expect(resolveDefaultPageId({} as ToolExecutionContext)).toBeUndefined();
  });

  it('returns undefined when context itself is undefined', () => {
    expect(resolveDefaultPageId(undefined)).toBeUndefined();
  });
});

describe('resolveOrThrowPageId', () => {
  it('returns the explicit pageId argument when provided, ignoring context', () => {
    const context = {
      currentWorkingPage: { id: 'working-page', title: 'Working', type: 'DOCUMENT' },
    } as ToolExecutionContext;
    expect(resolveOrThrowPageId('explicit-page', context)).toBe('explicit-page');
  });

  it('falls back to the default when pageId argument is omitted', () => {
    const context = {
      currentWorkingPage: { id: 'working-page', title: 'Working', type: 'DOCUMENT' },
    } as ToolExecutionContext;
    expect(resolveOrThrowPageId(undefined, context)).toBe('working-page');
  });

  it('throws a clear error when no pageId can be resolved', () => {
    expect(() => resolveOrThrowPageId(undefined, {} as ToolExecutionContext)).toThrow(
      'pageId is required: no page is currently in view and none was provided.',
    );
  });

  it('throws when context itself is undefined and no explicit pageId is given', () => {
    expect(() => resolveOrThrowPageId(undefined, undefined)).toThrow('pageId is required');
  });
});
