import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: {
        findFirst: vi.fn(),
      },
    },
  },
  pages: { id: 'id', parentId: 'parentId' },
  eq: vi.fn((_a, _b) => 'eq'),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  wouldCreateCircularReference,
  isDescendant,
  validatePageMove,
} from '../circular-reference-guard';
import { db } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupPageTree(tree: Record<string, string | null>) {
  vi.mocked(db.query.pages.findFirst).mockImplementation((async (args: unknown) => {
    const opts = args as { where: unknown; columns: unknown };
    // Extract the pageId from the eq call - we need to trace which id was queried.
    // Since eq is mocked as a no-op string, we use call arguments
    const eqMock = vi.mocked(require('@pagespace/db').eq);
    const calls = eqMock.mock.calls;
    if (calls.length === 0) return undefined;
    const lastCall = calls[calls.length - 1];
    const queriedId = lastCall[1] as string;
    const parentId = tree[queriedId];
    if (parentId === undefined) return undefined;
    return { parentId };
  }) as any);
}

// ---------------------------------------------------------------------------
// wouldCreateCircularReference
// ---------------------------------------------------------------------------

describe('wouldCreateCircularReference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when newParentId is null (moving to root)', async () => {
    const result = await wouldCreateCircularReference('page-1', null);
    expect(result).toBe(false);
    expect(db.query.pages.findFirst).not.toHaveBeenCalled();
  });

  it('returns true for self-reference (pageId === newParentId)', async () => {
    const result = await wouldCreateCircularReference('page-1', 'page-1');
    expect(result).toBe(true);
    expect(db.query.pages.findFirst).not.toHaveBeenCalled();
  });

  it('returns false when newParentId is not a descendant of pageId', async () => {
    // newParentId=page-2, ancestry: page-2 -> page-3 -> null
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ parentId: 'page-3' } as never)
      .mockResolvedValueOnce({ parentId: null } as never);

    const result = await wouldCreateCircularReference('page-1', 'page-2');
    expect(result).toBe(false);
  });

  it('returns true when newParentId is a descendant of pageId', async () => {
    // Structure: page-2 -> page-1 (i.e., page-2's parent is page-1)
    // So if we ask: would setting page-1's parent to page-2 create a circle?
    // isDescendant(page-2, page-1) -> page-2's parent is page-1 -> true
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ parentId: 'page-1' } as never);

    const result = await wouldCreateCircularReference('page-1', 'page-2');
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isDescendant
// ---------------------------------------------------------------------------

describe('isDescendant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when potentialDescendant directly has ancestorId as parent', async () => {
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ parentId: 'ancestor-id' } as never);

    const result = await isDescendant('child-id', 'ancestor-id');
    expect(result).toBe(true);
  });

  it('returns true when ancestor is multiple levels up', async () => {
    // child -> middle -> ancestor
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ parentId: 'middle-id' } as never)   // child's parent
      .mockResolvedValueOnce({ parentId: 'ancestor-id' } as never); // middle's parent

    const result = await isDescendant('child-id', 'ancestor-id');
    expect(result).toBe(true);
  });

  it('returns false when page is not a descendant (reaches root)', async () => {
    // child -> other-parent -> null (root)
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ parentId: 'other-parent' } as never)
      .mockResolvedValueOnce({ parentId: null } as never);

    const result = await isDescendant('child-id', 'ancestor-id');
    expect(result).toBe(false);
  });

  it('returns false when page not found in DB', async () => {
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce(undefined as never);

    const result = await isDescendant('nonexistent-id', 'ancestor-id');
    expect(result).toBe(false);
  });

  it('throws when depth exceeds MAX_DEPTH (cycle protection via unique ids)', async () => {
    // Mock findFirst to always return a unique new parent id so that the visited
    // set never triggers, but depth grows unboundedly. We simulate this by
    // returning incrementing fake ids — however since the visited check fires
    // before the depth limit in the actual implementation, we test that an error
    // is thrown in general for a deep/cyclic tree.
    let counter = 0;
    vi.mocked(db.query.pages.findFirst).mockImplementation((async () => {
      counter++;
      // After 100 calls the depth check fires; we return a unique id each time
      return { parentId: `unique-parent-${counter}` };
    }) as any);

    await expect(isDescendant('start-id', 'ancestor-id')).rejects.toThrow(
      /Page tree depth exceeded/
    );
  });

  it('throws when a cycle is detected in existing page tree', async () => {
    // A -> B -> A (cycle): start at A, find B, find A (already visited) -> throw
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ parentId: 'page-B' } as never)    // A -> B
      .mockResolvedValueOnce({ parentId: 'page-A' } as never);   // B -> A

    await expect(isDescendant('page-A', 'nonexistent-ancestor')).rejects.toThrow(
      /Circular reference detected/
    );
  });
});

// ---------------------------------------------------------------------------
// validatePageMove
// ---------------------------------------------------------------------------

describe('validatePageMove', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns valid when moving to root (null parent)', async () => {
    const result = await validatePageMove('page-1', null);
    expect(result).toEqual({ valid: true });
  });

  it('returns invalid with error message for self-reference', async () => {
    const result = await validatePageMove('page-1', 'page-1');
    expect(result).toEqual({
      valid: false,
      error: 'Cannot set parent: would create circular reference in page tree',
    });
  });

  it('returns invalid when circular reference would be created', async () => {
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ parentId: 'page-1' } as never);

    const result = await validatePageMove('page-1', 'page-2');
    expect(result).toEqual({
      valid: false,
      error: 'Cannot set parent: would create circular reference in page tree',
    });
  });

  it('returns valid when move is safe', async () => {
    vi.mocked(db.query.pages.findFirst)
      .mockResolvedValueOnce({ parentId: 'page-3' } as never)
      .mockResolvedValueOnce({ parentId: null } as never);

    const result = await validatePageMove('page-1', 'page-2');
    expect(result).toEqual({ valid: true });
  });

  it('returns invalid with error message when isDescendant throws (depth exceeded)', async () => {
    let counter = 0;
    vi.mocked(db.query.pages.findFirst).mockImplementation((async () => {
      counter++;
      return { parentId: `unique-parent-${counter}` };
    }) as any);

    const result = await validatePageMove('page-1', 'page-2');
    expect(result.valid).toBe(false);
    expect((result as { valid: false; error: string }).error).toContain('Page tree depth exceeded');
  });

  it('returns invalid with fallback error for non-Error throws', async () => {
    vi.mocked(db.query.pages.findFirst).mockRejectedValueOnce('string error');

    const result = await validatePageMove('page-1', 'page-2');
    expect(result.valid).toBe(false);
    expect((result as { valid: false; error: string }).error).toBe('Page move validation failed');
  });
});
