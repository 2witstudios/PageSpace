import { describe, it, expect } from 'vitest';
import {
  findNodeAndParent,
  removeNode,
  addNode,
  mergeChildren,
  buildTree,
  buildPagePath,
} from '../tree-utils';
import { TreePage } from '@/hooks/usePageTree';

// Helper to create test nodes
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

describe('tree-utils', () => {
  describe('findNodeAndParent', () => {
    it('finds node at root level with null parent', () => {
      const tree: TreePage[] = [
        createTreePage({ id: 'node-1', title: 'Node 1' }),
        createTreePage({ id: 'node-2', title: 'Node 2' }),
      ];

      const result = findNodeAndParent(tree, 'node-1');

      expect(result).not.toBeNull();
      expect(result?.node.id).toBe('node-1');
      expect(result?.parent).toBeNull();
    });

    it('finds nested node and returns parent', () => {
      const childNode = createTreePage({ id: 'child-1', title: 'Child' });
      const parentNode = createTreePage({
        id: 'parent-1',
        title: 'Parent',
        children: [childNode],
      });
      const tree: TreePage[] = [parentNode];

      const result = findNodeAndParent(tree, 'child-1');

      expect(result).not.toBeNull();
      expect(result?.node.id).toBe('child-1');
      expect(result?.parent?.id).toBe('parent-1');
    });

    it('finds deeply nested node', () => {
      const grandchild = createTreePage({ id: 'grandchild', title: 'Grandchild' });
      const child = createTreePage({
        id: 'child',
        title: 'Child',
        children: [grandchild],
      });
      const root = createTreePage({
        id: 'root',
        title: 'Root',
        children: [child],
      });
      const tree: TreePage[] = [root];

      const result = findNodeAndParent(tree, 'grandchild');

      expect(result).not.toBeNull();
      expect(result?.node.id).toBe('grandchild');
      expect(result?.parent?.id).toBe('child');
    });

    it('returns null for non-existent node', () => {
      const tree: TreePage[] = [
        createTreePage({ id: 'node-1', title: 'Node 1' }),
      ];

      const result = findNodeAndParent(tree, 'non-existent');

      expect(result).toBeNull();
    });

    it('handles empty tree', () => {
      const result = findNodeAndParent([], 'any-id');

      expect(result).toBeNull();
    });
  });

  describe('removeNode', () => {
    it('removes node from root level', () => {
      const tree: TreePage[] = [
        createTreePage({ id: 'node-1', title: 'Node 1' }),
        createTreePage({ id: 'node-2', title: 'Node 2' }),
      ];

      const result = removeNode(tree, 'node-1');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('node-2');
    });

    it('removes nested node', () => {
      const child = createTreePage({ id: 'child', title: 'Child' });
      const parent = createTreePage({
        id: 'parent',
        title: 'Parent',
        children: [child],
      });
      const tree: TreePage[] = [parent];

      const result = removeNode(tree, 'child');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('parent');
      expect(result[0].children).toHaveLength(0);
    });

    it('preserves sibling nodes when removing', () => {
      const child1 = createTreePage({ id: 'child-1', title: 'Child 1' });
      const child2 = createTreePage({ id: 'child-2', title: 'Child 2' });
      const parent = createTreePage({
        id: 'parent',
        title: 'Parent',
        children: [child1, child2],
      });
      const tree: TreePage[] = [parent];

      const result = removeNode(tree, 'child-1');

      expect(result[0].children).toHaveLength(1);
      expect(result[0].children![0].id).toBe('child-2');
    });

    it('returns unmodified tree if node not found', () => {
      const tree: TreePage[] = [
        createTreePage({ id: 'node-1', title: 'Node 1' }),
      ];

      const result = removeNode(tree, 'non-existent');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('node-1');
    });

    it('handles empty tree', () => {
      const result = removeNode([], 'any-id');

      expect(result).toHaveLength(0);
    });
  });

  describe('addNode', () => {
    it('adds node to root level at specified index', () => {
      const tree: TreePage[] = [
        createTreePage({ id: 'existing', title: 'Existing' }),
      ];
      const newNode = createTreePage({ id: 'new-node', title: 'New Node' });

      const result = addNode(tree, newNode, null, 0);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('new-node');
      expect(result[1].id).toBe('existing');
    });

    it('adds node to root level at end', () => {
      const tree: TreePage[] = [
        createTreePage({ id: 'existing', title: 'Existing' }),
      ];
      const newNode = createTreePage({ id: 'new-node', title: 'New Node' });

      const result = addNode(tree, newNode, null, 1);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('existing');
      expect(result[1].id).toBe('new-node');
    });

    it('adds node as child of parent', () => {
      const parent = createTreePage({
        id: 'parent',
        title: 'Parent',
        children: [],
      });
      const tree: TreePage[] = [parent];
      const newChild = createTreePage({ id: 'child', title: 'Child' });

      const result = addNode(tree, newChild, 'parent', 0);

      expect(result[0].children).toHaveLength(1);
      expect(result[0].children![0].id).toBe('child');
    });

    it('inserts child at correct position', () => {
      const existingChild = createTreePage({ id: 'existing-child', title: 'Existing' });
      const parent = createTreePage({
        id: 'parent',
        title: 'Parent',
        children: [existingChild],
      });
      const tree: TreePage[] = [parent];
      const newChild = createTreePage({ id: 'new-child', title: 'New Child' });

      const result = addNode(tree, newChild, 'parent', 0);

      expect(result[0].children).toHaveLength(2);
      expect(result[0].children![0].id).toBe('new-child');
      expect(result[0].children![1].id).toBe('existing-child');
    });

    it('adds to deeply nested parent', () => {
      const child = createTreePage({ id: 'child', title: 'Child', children: [] });
      const root = createTreePage({
        id: 'root',
        title: 'Root',
        children: [child],
      });
      const tree: TreePage[] = [root];
      const grandchild = createTreePage({ id: 'grandchild', title: 'Grandchild' });

      const result = addNode(tree, grandchild, 'child', 0);

      expect(result[0].children![0].children).toHaveLength(1);
      expect(result[0].children![0].children![0].id).toBe('grandchild');
    });

    it('handles adding to empty tree', () => {
      const newNode = createTreePage({ id: 'first', title: 'First' });

      const result = addNode([], newNode, null, 0);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('first');
    });
  });

  describe('mergeChildren', () => {
    it('replaces children of specified parent', () => {
      const oldChild = createTreePage({ id: 'old-child', title: 'Old' });
      const parent = createTreePage({
        id: 'parent',
        title: 'Parent',
        children: [oldChild],
      });
      const tree: TreePage[] = [parent];
      const newChildren: TreePage[] = [
        createTreePage({ id: 'new-1', title: 'New 1', position: 1 }),
        createTreePage({ id: 'new-2', title: 'New 2', position: 0 }),
      ];

      const result = mergeChildren(tree, 'parent', newChildren);

      expect(result[0].children).toHaveLength(2);
      // Children should be sorted by position
      expect(result[0].children![0].id).toBe('new-2');
      expect(result[0].children![1].id).toBe('new-1');
    });

    it('merges children for nested parent', () => {
      const nestedParent = createTreePage({
        id: 'nested-parent',
        title: 'Nested Parent',
        children: [],
      });
      const root = createTreePage({
        id: 'root',
        title: 'Root',
        children: [nestedParent],
      });
      const tree: TreePage[] = [root];
      const newChildren: TreePage[] = [
        createTreePage({ id: 'nested-child', title: 'Nested Child', position: 0 }),
      ];

      const result = mergeChildren(tree, 'nested-parent', newChildren);

      expect(result[0].children![0].children).toHaveLength(1);
      expect(result[0].children![0].children![0].id).toBe('nested-child');
    });

    it('preserves tree structure for non-matching parents', () => {
      const parent1 = createTreePage({
        id: 'parent-1',
        title: 'Parent 1',
        children: [createTreePage({ id: 'child-1', title: 'Child 1' })],
      });
      const parent2 = createTreePage({
        id: 'parent-2',
        title: 'Parent 2',
        children: [],
      });
      const tree: TreePage[] = [parent1, parent2];
      const newChildren: TreePage[] = [
        createTreePage({ id: 'new-child', title: 'New Child', position: 0 }),
      ];

      const result = mergeChildren(tree, 'parent-2', newChildren);

      expect(result[0].children).toHaveLength(1);
      expect(result[0].children![0].id).toBe('child-1');
      expect(result[1].children).toHaveLength(1);
      expect(result[1].children![0].id).toBe('new-child');
    });
  });

  describe('buildTree', () => {
    it('builds flat tree from root nodes', () => {
      const nodes = [
        { id: 'node-1', parentId: null, position: 0 },
        { id: 'node-2', parentId: null, position: 1 },
      ];

      const result = buildTree(nodes);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('node-1');
      expect(result[1].id).toBe('node-2');
    });

    it('nests children under parent', () => {
      const nodes = [
        { id: 'parent', parentId: null, position: 0 },
        { id: 'child', parentId: 'parent', position: 0 },
      ];

      const result = buildTree(nodes);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('parent');
      expect(result[0].children).toHaveLength(1);
      expect(result[0].children[0].id).toBe('child');
    });

    it('sorts by position', () => {
      const nodes = [
        { id: 'node-3', parentId: null, position: 2 },
        { id: 'node-1', parentId: null, position: 0 },
        { id: 'node-2', parentId: null, position: 1 },
      ];

      const result = buildTree(nodes);

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('node-1');
      expect(result[1].id).toBe('node-2');
      expect(result[2].id).toBe('node-3');
    });

    it('handles deeply nested structure', () => {
      const nodes = [
        { id: 'root', parentId: null, position: 0 },
        { id: 'child', parentId: 'root', position: 0 },
        { id: 'grandchild', parentId: 'child', position: 0 },
      ];

      const result = buildTree(nodes);

      expect(result).toHaveLength(1);
      expect(result[0].children[0].children[0].id).toBe('grandchild');
    });

    it('handles orphaned nodes as roots', () => {
      const nodes = [
        { id: 'orphan', parentId: 'non-existent', position: 0 },
        { id: 'root', parentId: null, position: 1 },
      ];

      const result = buildTree(nodes);

      // Orphan should be treated as root since parent doesn't exist
      expect(result).toHaveLength(2);
    });

    it('handles empty input', () => {
      const result = buildTree([]);

      expect(result).toHaveLength(0);
    });

    it('handles undefined position', () => {
      const nodes = [
        { id: 'node-1', parentId: null },
        { id: 'node-2', parentId: null },
      ];

      const result = buildTree(nodes);

      expect(result).toHaveLength(2);
    });
  });

  describe('buildPagePath', () => {
    it('builds path for root page', () => {
      const tree: TreePage[] = [
        createTreePage({ id: 'page-1', title: 'My Page' }),
      ];

      const result = buildPagePath(tree, 'page-1', 'workspace');

      expect(result).not.toBeNull();
      expect(result?.path).toBe('/workspace/My Page');
      expect(result?.parentPath).toBe('/workspace');
      expect(result?.breadcrumbs).toEqual(['workspace', 'My Page']);
    });

    it('builds path for nested page', () => {
      const child = createTreePage({ id: 'child', title: 'Child Page' });
      const parent = createTreePage({
        id: 'parent',
        title: 'Parent Folder',
        children: [child],
      });
      const tree: TreePage[] = [parent];

      const result = buildPagePath(tree, 'child', 'workspace');

      expect(result).not.toBeNull();
      expect(result?.path).toBe('/workspace/Parent Folder/Child Page');
      expect(result?.parentPath).toBe('/workspace/Parent Folder');
      expect(result?.breadcrumbs).toEqual(['workspace', 'Parent Folder', 'Child Page']);
    });

    it('builds path for deeply nested page', () => {
      const grandchild = createTreePage({ id: 'grandchild', title: 'Deep Page' });
      const child = createTreePage({
        id: 'child',
        title: 'Folder 2',
        children: [grandchild],
      });
      const root = createTreePage({
        id: 'root',
        title: 'Folder 1',
        children: [child],
      });
      const tree: TreePage[] = [root];

      const result = buildPagePath(tree, 'grandchild', 'my-drive');

      expect(result).not.toBeNull();
      expect(result?.path).toBe('/my-drive/Folder 1/Folder 2/Deep Page');
      expect(result?.parentPath).toBe('/my-drive/Folder 1/Folder 2');
      expect(result?.breadcrumbs).toEqual(['my-drive', 'Folder 1', 'Folder 2', 'Deep Page']);
    });

    it('returns null for non-existent node', () => {
      const tree: TreePage[] = [
        createTreePage({ id: 'page-1', title: 'Page 1' }),
      ];

      const result = buildPagePath(tree, 'non-existent', 'workspace');

      expect(result).toBeNull();
    });

    it('handles empty tree', () => {
      const result = buildPagePath([], 'any-id', 'workspace');

      expect(result).toBeNull();
    });

    it('handles special characters in titles', () => {
      const tree: TreePage[] = [
        createTreePage({ id: 'page-1', title: 'Page with / slashes' }),
      ];

      const result = buildPagePath(tree, 'page-1', 'workspace');

      expect(result).not.toBeNull();
      expect(result?.path).toBe('/workspace/Page with / slashes');
    });
  });
});
