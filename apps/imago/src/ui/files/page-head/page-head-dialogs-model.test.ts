import { describe, expect, it } from 'vitest';
import { hasChildrenIn } from './page-head-dialogs-model';

describe('hasChildrenIn', () => {
  const tree = [
    { id: 'a', children: [{ id: 'b', children: [{ id: 'c' }] }, { id: 'd' }] },
    { id: 'e' },
  ];

  it('finds a page nested deeper in the tree', () => {
    expect(hasChildrenIn(tree, 'b')).toBe(true);
  });

  it('is false for a leaf, for an unknown page and before the tree loads', () => {
    expect(hasChildrenIn(tree, 'c')).toBe(false);
    expect(hasChildrenIn(tree, 'e')).toBe(false);
    expect(hasChildrenIn(tree, 'zzz')).toBe(false);
    expect(hasChildrenIn(undefined, 'a')).toBe(false);
  });
});
