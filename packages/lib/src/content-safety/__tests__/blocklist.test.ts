import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockWhere = vi.fn();
const mockFrom = vi.fn(() => ({ where: mockWhere }));
const mockSelect = vi.fn(() => ({ from: mockFrom }));

vi.mock('@pagespace/db/db', () => ({
  db: { select: (...a: unknown[]) => mockSelect(...(a as [])) },
}));

vi.mock('@pagespace/db/operators', () => ({
  inArray: vi.fn((column: unknown, values: unknown[]) => ({ op: 'inArray', column, values })),
}));

vi.mock('@pagespace/db/schema/content-safety', () => ({
  contentBlocks: { contentHash: 'content_blocks.content_hash' },
}));

import { findBlockedHashes, isHashBlocked } from '../blocklist';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('findBlockedHashes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockResolvedValue([]);
  });

  it('returns the subset of hashes that are on the blocklist', async () => {
    mockWhere.mockResolvedValue([{ contentHash: HASH_B }]);

    const blocked = await findBlockedHashes([HASH_A, HASH_B]);

    expect(blocked).toEqual(new Set([HASH_B]));
    expect(mockWhere).toHaveBeenCalledWith({
      op: 'inArray',
      column: 'content_blocks.content_hash',
      values: [HASH_A, HASH_B],
    });
  });

  it('looks hashes up in canonical lowercase form, so casing cannot dodge a block', async () => {
    mockWhere.mockResolvedValue([{ contentHash: HASH_A }]);

    const blocked = await findBlockedHashes([HASH_A.toUpperCase()]);

    expect(blocked.has(HASH_A)).toBe(true);
    expect(mockWhere).toHaveBeenCalledWith(expect.objectContaining({ values: [HASH_A] }));
  });

  it('does not query when given no valid hashes', async () => {
    expect(await findBlockedHashes([])).toEqual(new Set());
    expect(await findBlockedHashes(['not-a-hash'])).toEqual(new Set());
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('lets a lookup failure propagate, so a broken blocklist fails closed', async () => {
    mockWhere.mockRejectedValue(new Error('db down'));
    await expect(findBlockedHashes([HASH_A])).rejects.toThrow('db down');
  });
});

describe('isHashBlocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWhere.mockResolvedValue([]);
  });

  it('is true for a blocked hash', async () => {
    mockWhere.mockResolvedValue([{ contentHash: HASH_A }]);
    expect(await isHashBlocked(HASH_A)).toBe(true);
  });

  it('is true for a blocked hash supplied in another casing', async () => {
    mockWhere.mockResolvedValue([{ contentHash: HASH_A }]);
    expect(await isHashBlocked(HASH_A.toUpperCase())).toBe(true);
  });

  it('is false for a hash that is not on the blocklist', async () => {
    expect(await isHashBlocked(HASH_A)).toBe(false);
  });

  it('is false for a value that is not a content hash', async () => {
    expect(await isHashBlocked('not-a-hash')).toBe(false);
    expect(mockSelect).not.toHaveBeenCalled();
  });
});
