import { describe, it, expect } from 'vitest'
import { buildTree } from '../tree-utils'

describe('tree-utils', () => {
  describe('buildTree', () => {
    it('builds tree from flat list of nodes', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root 1' },
        { id: '2', parentId: null, title: 'Root 2' },
        { id: '3', parentId: '1', title: 'Child 1-1' },
        { id: '4', parentId: '1', title: 'Child 1-2' },
      ]

      const tree = buildTree(nodes)

      expect(tree).toHaveLength(2) // Two root nodes
      expect(tree[0].id).toBe('1')
      expect(tree[0].children).toHaveLength(2)
      expect(tree[1].id).toBe('2')
      expect(tree[1].children).toHaveLength(0)
    })

    it('handles empty input array', () => {
      const tree = buildTree([])
      expect(tree).toEqual([])
    })

    it('handles single root node', () => {
      const nodes = [{ id: '1', parentId: null, title: 'Root' }]
      const tree = buildTree(nodes)

      expect(tree).toHaveLength(1)
      expect(tree[0].id).toBe('1')
      expect(tree[0].children).toEqual([])
    })

    it('handles single root with single child', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root' },
        { id: '2', parentId: '1', title: 'Child' },
      ]

      const tree = buildTree(nodes)

      expect(tree).toHaveLength(1)
      expect(tree[0].children).toHaveLength(1)
      expect(tree[0].children[0].id).toBe('2')
    })

    it('builds deeply nested tree structure', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root' },
        { id: '2', parentId: '1', title: 'Level 1' },
        { id: '3', parentId: '2', title: 'Level 2' },
        { id: '4', parentId: '3', title: 'Level 3' },
        { id: '5', parentId: '4', title: 'Level 4' },
      ]

      const tree = buildTree(nodes)

      expect(tree).toHaveLength(1)
      expect(tree[0].children[0].children[0].children[0].children[0].id).toBe('5')
    })

    it('handles multiple root nodes with children', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root 1' },
        { id: '2', parentId: null, title: 'Root 2' },
        { id: '3', parentId: '1', title: 'Child 1-1' },
        { id: '4', parentId: '2', title: 'Child 2-1' },
      ]

      const tree = buildTree(nodes)

      expect(tree).toHaveLength(2)
      expect(tree[0].children).toHaveLength(1)
      expect(tree[1].children).toHaveLength(1)
    })

    it('handles orphaned nodes (parent does not exist)', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root' },
        { id: '2', parentId: 'nonexistent', title: 'Orphan' },
      ]

      const tree = buildTree(nodes)

      // Orphaned nodes become root nodes
      expect(tree).toHaveLength(2)
      expect(tree.find(n => n.id === '2')).toBeTruthy()
    })

    it('preserves node properties in tree', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root', type: 'FOLDER', metadata: { foo: 'bar' } },
        { id: '2', parentId: '1', title: 'Child', type: 'DOCUMENT', metadata: { baz: 'qux' } },
      ]

      const tree = buildTree(nodes)

      expect(tree[0].type).toBe('FOLDER')
      expect(tree[0].metadata).toEqual({ foo: 'bar' })
      expect(tree[0].children[0].type).toBe('DOCUMENT')
      expect(tree[0].children[0].metadata).toEqual({ baz: 'qux' })
    })

    it('handles nodes in arbitrary order', () => {
      const nodes = [
        { id: '3', parentId: '1', title: 'Child' },
        { id: '1', parentId: null, title: 'Root' },
        { id: '2', parentId: null, title: 'Root 2' },
      ]

      const tree = buildTree(nodes)

      expect(tree).toHaveLength(2)
      const root1 = tree.find(n => n.id === '1')
      expect(root1?.children).toHaveLength(1)
      expect(root1?.children[0].id).toBe('3')
    })

    it('handles wide tree (many siblings)', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root' },
        { id: '2', parentId: '1', title: 'Child 1' },
        { id: '3', parentId: '1', title: 'Child 2' },
        { id: '4', parentId: '1', title: 'Child 3' },
        { id: '5', parentId: '1', title: 'Child 4' },
        { id: '6', parentId: '1', title: 'Child 5' },
      ]

      const tree = buildTree(nodes)

      expect(tree).toHaveLength(1)
      expect(tree[0].children).toHaveLength(5)
    })

    it('handles complex mixed hierarchy', () => {
      const nodes = [
        { id: 'r1', parentId: null, title: 'Root 1' },
        { id: 'r2', parentId: null, title: 'Root 2' },
        { id: 'r1c1', parentId: 'r1', title: 'R1 Child 1' },
        { id: 'r1c2', parentId: 'r1', title: 'R1 Child 2' },
        { id: 'r2c1', parentId: 'r2', title: 'R2 Child 1' },
        { id: 'r1c1c1', parentId: 'r1c1', title: 'R1 C1 Grandchild' },
      ]

      const tree = buildTree(nodes)

      expect(tree).toHaveLength(2)

      const root1 = tree.find(n => n.id === 'r1')
      const root2 = tree.find(n => n.id === 'r2')

      expect(root1?.children).toHaveLength(2)
      expect(root2?.children).toHaveLength(1)
      expect(root1?.children[0].children).toHaveLength(1)
    })

    it('adds empty children array to leaf nodes', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root' },
        { id: '2', parentId: '1', title: 'Leaf' },
      ]

      const tree = buildTree(nodes)

      expect(tree[0].children[0].children).toEqual([])
    })

    it('handles nodes with null parentId correctly', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root 1' },
        { id: '2', parentId: null, title: 'Root 2' },
      ]

      const tree = buildTree(nodes)

      expect(tree).toHaveLength(2)
      expect(tree.every(node => node.parentId === null)).toBe(true)
    })

    it('maintains parent references in children', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root' },
        { id: '2', parentId: '1', title: 'Child' },
      ]

      const tree = buildTree(nodes)

      expect(tree[0].children[0].parentId).toBe('1')
    })

    it('handles duplicate IDs gracefully (last one wins)', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root First' },
        { id: '1', parentId: null, title: 'Root Second' },
      ]

      const tree = buildTree(nodes)

      // Map will keep last occurrence
      expect(tree).toHaveLength(1)
      expect(tree[0].title).toBe('Root Second')
    })

    it('handles large dataset efficiently', () => {
      const nodes = []
      for (let i = 0; i < 1000; i++) {
        nodes.push({
          id: `node-${i}`,
          parentId: i === 0 ? null : `node-${Math.floor(i / 2)}`,
          title: `Node ${i}`,
        })
      }

      const startTime = Date.now()
      const tree = buildTree(nodes)
      const duration = Date.now() - startTime

      expect(tree).toBeTruthy()
      expect(duration).toBeLessThan(100) // Should build in under 100ms
    })

    it('handles all nodes being roots', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root 1' },
        { id: '2', parentId: null, title: 'Root 2' },
        { id: '3', parentId: null, title: 'Root 3' },
      ]

      const tree = buildTree(nodes)

      expect(tree).toHaveLength(3)
      expect(tree.every(node => node.children.length === 0)).toBe(true)
    })

    it('handles all nodes being children of single parent', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root' },
        { id: '2', parentId: '1', title: 'Child 1' },
        { id: '3', parentId: '1', title: 'Child 2' },
        { id: '4', parentId: '1', title: 'Child 3' },
      ]

      const tree = buildTree(nodes)

      expect(tree).toHaveLength(1)
      expect(tree[0].children).toHaveLength(3)
    })

    it('preserves insertion order for children', () => {
      const nodes = [
        { id: '1', parentId: null, title: 'Root' },
        { id: '2', parentId: '1', title: 'First' },
        { id: '3', parentId: '1', title: 'Second' },
        { id: '4', parentId: '1', title: 'Third' },
      ]

      const tree = buildTree(nodes)

      expect(tree[0].children[0].title).toBe('First')
      expect(tree[0].children[1].title).toBe('Second')
      expect(tree[0].children[2].title).toBe('Third')
    })

    it('works with string IDs', () => {
      const nodes = [
        { id: 'root-abc', parentId: null, title: 'Root' },
        { id: 'child-xyz', parentId: 'root-abc', title: 'Child' },
      ]

      const tree = buildTree(nodes)

      expect(tree[0].id).toBe('root-abc')
      expect(tree[0].children[0].id).toBe('child-xyz')
    })

    it('handles nodes with numeric-like string IDs', () => {
      const nodes = [
        { id: '001', parentId: null, title: 'Root' },
        { id: '002', parentId: '001', title: 'Child' },
      ]

      const tree = buildTree(nodes)

      expect(tree[0].id).toBe('001')
      expect(tree[0].children[0].id).toBe('002')
    })
  })
})
