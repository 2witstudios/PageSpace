import { describe, it, expect } from 'vitest';
import type { SheetData, SheetExternalReferenceToken } from '@pagespace/lib/sheets/sheet';
import { PageType } from '@pagespace/lib/utils/enums';
import {
  flattenTree,
  buildParentMap,
  buildAncestorChain,
  compareReferenceMatches,
  resolveReferenceTarget,
  resolveExternalReference,
  type SheetTreeNode,
  type ExternalSheetState,
  type ReferenceMatch,
} from '../references';

const assert = ({ given, should, actual, expected }: {
  given: string; should: string; actual: unknown; expected: unknown;
}) => expect(actual, `Given ${given}, should ${should}`).toEqual(expected);

const node = (over: Partial<SheetTreeNode> & { id: string }): SheetTreeNode => ({
  parentId: null,
  type: PageType.SHEET,
  title: 'Untitled',
  position: 0,
  ...over,
});

const token = (over: Partial<SheetExternalReferenceToken> = {}): SheetExternalReferenceToken => ({
  raw: '[[Budget]]',
  label: 'Budget',
  normalizedLabel: 'budget',
  ...over,
});

const emptySheet = (): SheetData => ({ version: 1, rowCount: 1, columnCount: 1, cells: {} });

describe('flattenTree', () => {
  it('walks nested children depth-first', () => {
    const tree: SheetTreeNode[] = [
      node({ id: 'a', children: [node({ id: 'a1' }), node({ id: 'a2', children: [node({ id: 'a2a' })] })] }),
      node({ id: 'b' }),
    ];
    assert({
      given: 'a tree with nested children',
      should: 'return every node flattened in order',
      actual: flattenTree(tree).map((n) => n.id),
      expected: ['a', 'a1', 'a2', 'a2a', 'b'],
    });
  });

  it('handles a node whose children array is empty', () => {
    assert({
      given: 'a node with an empty children array',
      should: 'not descend and just return the node',
      actual: flattenTree([node({ id: 'a', children: [] })]).map((n) => n.id),
      expected: ['a'],
    });
  });

  it('returns an empty array for an empty forest', () => {
    assert({
      given: 'an empty tree',
      should: 'return an empty array',
      actual: flattenTree([]),
      expected: [],
    });
  });
});

describe('buildParentMap', () => {
  it('maps each node id to its parent id, defaulting to null', () => {
    const flat = [node({ id: 'a' }), node({ id: 'b', parentId: 'a' }), node({ id: 'c', parentId: undefined })];
    const map = buildParentMap(flat);
    assert({
      given: 'a flat list with present and absent parent ids',
      should: 'map ids to parent id or null',
      actual: [map.get('a'), map.get('b'), map.get('c')],
      expected: [null, 'a', null],
    });
  });
});

describe('buildAncestorChain', () => {
  it('walks parents from the node to the root', () => {
    const map = new Map<string, string | null>([
      ['c', 'b'],
      ['b', 'a'],
      ['a', null],
    ]);
    assert({
      given: 'a linear parent map',
      should: 'return the chain from node to root',
      actual: buildAncestorChain('c', map),
      expected: ['c', 'b', 'a'],
    });
  });

  it('terminates on a cycle via the visited set', () => {
    const map = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    assert({
      given: 'a parent map with an a<->b cycle',
      should: 'stop once a node repeats rather than loop forever',
      actual: buildAncestorChain('a', map),
      expected: ['a', 'b'],
    });
  });

  it('returns an empty chain for a null id', () => {
    assert({
      given: 'a null starting id',
      should: 'return an empty chain',
      actual: buildAncestorChain(null, new Map()),
      expected: [],
    });
  });
});

describe('compareReferenceMatches', () => {
  const match = (over: Partial<ReferenceMatch>): ReferenceMatch => ({
    node: node({ id: 'x', title: 'Budget' }),
    isSibling: false,
    sharedDepth: 0,
    depth: 1,
    position: 0,
    ...over,
  });

  it('ranks a sibling before a non-sibling', () => {
    assert({
      given: 'a sibling (a) and a non-sibling (b)',
      should: 'rank the sibling first (negative)',
      actual: Math.sign(compareReferenceMatches(match({ isSibling: true }), match({ isSibling: false }))),
      expected: -1,
    });
  });

  it('ranks a non-sibling after a sibling', () => {
    assert({
      given: 'a non-sibling (a) and a sibling (b)',
      should: 'rank the non-sibling last (positive)',
      actual: Math.sign(compareReferenceMatches(match({ isSibling: false }), match({ isSibling: true }))),
      expected: 1,
    });
  });

  it('prefers the higher shared depth when sibling status ties', () => {
    assert({
      given: 'equal sibling status but a has greater sharedDepth',
      should: 'rank the greater sharedDepth first',
      actual: Math.sign(compareReferenceMatches(match({ sharedDepth: 2 }), match({ sharedDepth: 1 }))),
      expected: -1,
    });
  });

  it('prefers the shallower node when sharedDepth ties', () => {
    assert({
      given: 'equal sibling and sharedDepth but a is shallower',
      should: 'rank the shallower node first',
      actual: Math.sign(compareReferenceMatches(match({ depth: 1 }), match({ depth: 3 }))),
      expected: -1,
    });
  });

  it('prefers the lower position when depth ties', () => {
    assert({
      given: 'equal sibling, sharedDepth and depth but a has a lower position',
      should: 'rank the lower position first',
      actual: Math.sign(compareReferenceMatches(match({ position: 1 }), match({ position: 5 }))),
      expected: -1,
    });
  });

  it('falls back to title comparison when all else ties', () => {
    assert({
      given: 'all keys equal but different titles',
      should: 'order by title localeCompare',
      actual: Math.sign(
        compareReferenceMatches(
          match({ node: node({ id: 'a', title: 'Alpha' }) }),
          match({ node: node({ id: 'b', title: 'Beta' }) }),
        ),
      ),
      expected: -1,
    });
  });
});

describe('resolveReferenceTarget', () => {
  const ctx = (flattenedPages: SheetTreeNode[], currentPageId = 'cur', currentParentId: string | null = 'p1') => ({
    flattenedPages,
    parentMap: buildParentMap(flattenedPages),
    currentPageId,
    currentParentId,
  });

  it('resolves by identifier when it points at a sheet', () => {
    const pages = [node({ id: 'sheet-1', title: 'Whatever' })];
    assert({
      given: 'a reference with an identifier matching a sheet id',
      should: 'resolve directly by id',
      actual: resolveReferenceTarget(token({ identifier: 'sheet-1' }), ctx(pages)),
      expected: { pageId: 'sheet-1', title: 'Whatever' },
    });
  });

  it('falls through to label matching when the identifier is not a sheet', () => {
    const pages = [
      node({ id: 'doc-1', type: PageType.DOCUMENT, title: 'Budget' }),
      node({ id: 'sheet-2', title: 'Budget' }),
    ];
    assert({
      given: 'an identifier pointing at a non-sheet, plus one label match',
      should: 'ignore the identifier and resolve the sheet by label',
      actual: resolveReferenceTarget(token({ identifier: 'doc-1' }), ctx(pages)),
      expected: { pageId: 'sheet-2', title: 'Budget' },
    });
  });

  it('resolves a unique label match', () => {
    const pages = [node({ id: 'sheet-3', title: 'Budget' })];
    assert({
      given: 'exactly one sheet titled Budget',
      should: 'resolve it',
      actual: resolveReferenceTarget(token(), ctx(pages)),
      expected: { pageId: 'sheet-3', title: 'Budget' },
    });
  });

  it('returns null when no sheet matches the label', () => {
    const pages = [node({ id: 'sheet-4', title: 'Other' })];
    assert({
      given: 'no sheet matching the label',
      should: 'return null',
      actual: resolveReferenceTarget(token(), ctx(pages)),
      expected: null,
    });
  });

  it('ranks a sibling ahead of a deeper match among duplicates', () => {
    const pages = [
      node({ id: 'cur', parentId: 'p1', title: 'Current' }),
      node({ id: 'p1', parentId: null, title: 'Parent' }),
      node({ id: 'sib', parentId: 'p1', title: 'Budget' }),
      node({ id: 'far', parentId: 'elsewhere', title: 'Budget' }),
      node({ id: 'elsewhere', parentId: null, title: 'Folder' }),
    ];
    assert({
      given: 'two sheets titled Budget, one a sibling of the current page',
      should: 'prefer the sibling',
      actual: resolveReferenceTarget(token(), ctx(pages)),
      expected: { pageId: 'sib', title: 'Budget' },
    });
  });
});

describe('resolveExternalReference', () => {
  it('reports a loading state when no entry exists yet, using the identifier', () => {
    const result = resolveExternalReference(token({ identifier: 'id-9' }), {});
    assert({
      given: 'no cached entry for a reference with an identifier',
      should: 'report loading with the identifier as pageId',
      actual: { pageId: result.pageId, error: result.error },
      expected: { pageId: 'id-9', error: 'Referenced page "Budget" is loading' },
    });
  });

  it('falls back to raw when no entry and no identifier', () => {
    const result = resolveExternalReference(token(), {});
    assert({
      given: 'no cached entry and no identifier',
      should: 'use the raw token as pageId',
      actual: result.pageId,
      expected: '[[Budget]]',
    });
  });

  it('returns the sheet for a ready entry', () => {
    const sheet = emptySheet();
    const entries: Record<string, ExternalSheetState> = {
      '[[Budget]]': { status: 'ready', label: 'Budget', pageId: 'p', title: 'Budget', sheet },
    };
    assert({
      given: 'a ready cached entry',
      should: 'return its sheet',
      actual: resolveExternalReference(token(), entries),
      expected: { pageId: 'p', pageTitle: 'Budget', sheet },
    });
  });

  it('reports loading for a loading entry', () => {
    const entries: Record<string, ExternalSheetState> = {
      '[[Budget]]': { status: 'loading', label: 'Budget', pageId: 'p', title: 'Budget' },
    };
    assert({
      given: 'a loading cached entry',
      should: 'report the loading error keyed on the resolved title',
      actual: resolveExternalReference(token(), entries),
      expected: { pageId: 'p', pageTitle: 'Budget', error: 'Referenced page "Budget" is loading' },
    });
  });

  it('surfaces the stored error for an error entry with page details', () => {
    const entries: Record<string, ExternalSheetState> = {
      '[[Budget]]': { status: 'error', label: 'Budget', pageId: 'p', title: 'Budget', error: 'no access' },
    };
    assert({
      given: 'an error entry carrying pageId and title',
      should: 'surface the stored error with those details',
      actual: resolveExternalReference(token(), entries),
      expected: { pageId: 'p', pageTitle: 'Budget', error: 'no access' },
    });
  });

  it('falls back to token details for an error entry missing page info', () => {
    const entries: Record<string, ExternalSheetState> = {
      '[[Budget]]': { status: 'error', label: 'Budget', error: 'boom' },
    };
    assert({
      given: 'an error entry with no pageId/title',
      should: 'fall back to the identifier/raw and label',
      actual: resolveExternalReference(token({ identifier: 'id-2' }), entries),
      expected: { pageId: 'id-2', pageTitle: 'Budget', error: 'boom' },
    });
  });
});
