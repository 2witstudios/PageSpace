import { describe, it, expect } from 'vitest';
import { resolveHomeRedirectTarget } from '../home-redirect';
import { TreePage } from '@/hooks/usePageTree';

// Helper to create test nodes (same pattern as tree-utils.test.ts)
function createTreePage(overrides: Partial<TreePage> = {}): TreePage {
  return {
    id: 'test-id',
    title: 'Test Page',
    type: 'DOCUMENT',
    position: 0,
    driveId: 'drive-1',
    parentId: null,
    children: [],
    ...overrides,
  } as TreePage;
}

describe('resolveHomeRedirectTarget', () => {
  it('returns null for a null homePageId', () => {
    const tree = [createTreePage({ id: 'page-1' })];

    expect(resolveHomeRedirectTarget(null, tree)).toBeNull();
  });

  it('returns null for an undefined homePageId', () => {
    const tree = [createTreePage({ id: 'page-1' })];

    expect(resolveHomeRedirectTarget(undefined, tree)).toBeNull();
  });

  it('returns the pageId when it matches a root-level node', () => {
    const tree = [
      createTreePage({ id: 'page-1' }),
      createTreePage({ id: 'page-2' }),
    ];

    expect(resolveHomeRedirectTarget('page-2', tree)).toBe('page-2');
  });

  it('returns the pageId when it matches a deeply nested node', () => {
    const tree = [
      createTreePage({
        id: 'root',
        children: [
          createTreePage({
            id: 'level-1',
            parentId: 'root',
            children: [
              createTreePage({
                id: 'level-2',
                parentId: 'level-1',
                children: [createTreePage({ id: 'level-3', parentId: 'level-2' })],
              }),
            ],
          }),
        ],
      }),
    ];

    expect(resolveHomeRedirectTarget('level-3', tree)).toBe('level-3');
  });

  it('returns null when the pageId is absent from the tree (trashed / deleted / not viewable)', () => {
    const tree = [
      createTreePage({ id: 'page-1', children: [createTreePage({ id: 'child-1', parentId: 'page-1' })] }),
    ];

    expect(resolveHomeRedirectTarget('page-gone', tree)).toBeNull();
  });

  it('returns null for an empty tree even with a non-null homePageId', () => {
    expect(resolveHomeRedirectTarget('page-1', [])).toBeNull();
  });
});
