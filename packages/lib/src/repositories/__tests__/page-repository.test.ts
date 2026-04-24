import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      pages: { findFirst: vi.fn() },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  pages: {
    id: 'id', title: 'title', type: 'type', content: 'content', driveId: 'driveId',
    parentId: 'parentId', position: 'position', isTrashed: 'isTrashed',
    trashedAt: 'trashedAt', updatedAt: 'updatedAt', revision: 'revision',
    stateHash: 'stateHash', contentMode: 'contentMode',
  },
  eq: vi.fn((_a, _b) => 'eq'),
  and: vi.fn((...args) => ({ and: args })),
  desc: vi.fn((a) => ({ desc: a })),
  isNull: vi.fn((a) => ({ isNull: a })),
  inArray: vi.fn((a, b) => ({ inArray: { a, b } })),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { pageRepository } from '../page-repository';
import { db } from '@pagespace/db/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pageRow = {
  id: 'page-1',
  title: 'My Page',
  type: 'DOCUMENT',
  content: '<p>Hello</p>',
  contentMode: 'html',
  driveId: 'drive-1',
  parentId: null,
  position: 1,
  isTrashed: false,
  trashedAt: null,
  revision: 0,
  stateHash: null,
};

function setupSelectChain(rows: unknown[]) {
  const orderByFn = vi.fn().mockResolvedValue(rows);
  const limitFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn, limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);
  return { whereFn, orderByFn, limitFn };
}

function setupInsertChain(row: unknown) {
  const returningFn = vi.fn().mockResolvedValue([row]);
  const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
  vi.mocked(db.insert).mockReturnValue({ values: valuesFn } as unknown as ReturnType<typeof db.insert>);
  return { valuesFn, returningFn };
}

function setupUpdateChain(rows: unknown[]) {
  const returningFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);
  return { setFn, whereFn, returningFn };
}

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------
describe('pageRepository.findById', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns page when found (default excludes trashed)', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow as never);

    const result = await pageRepository.findById('page-1');
    expect(result).toEqual(pageRow);
  });

  it('returns falsy when page not found', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

    const result = await pageRepository.findById('nonexistent');
    expect(result).toBeFalsy();
  });

  it('includes trashed pages when includeTrashed=true', async () => {
    const trashedPage = { ...pageRow, isTrashed: true };
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(trashedPage as never);

    const result = await pageRepository.findById('page-1', { includeTrashed: true });
    expect(result?.isTrashed).toBe(true);
  });

  it('returns non-trashed page when includeTrashed=false', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(pageRow as never);

    const result = await pageRepository.findById('page-1', { includeTrashed: false });
    expect(result).toEqual(pageRow);
    expect(result?.isTrashed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findTrashedById
// ---------------------------------------------------------------------------
describe('pageRepository.findTrashedById', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns trashed page when found', async () => {
    const trashedPage = { ...pageRow, isTrashed: true };
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(trashedPage as never);

    const result = await pageRepository.findTrashedById('page-1');
    expect(result?.isTrashed).toBe(true);
  });

  it('returns falsy when page not found', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

    const result = await pageRepository.findTrashedById('nonexistent');
    expect(result).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// findAgentById
// ---------------------------------------------------------------------------
describe('pageRepository.findAgentById', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns agent page when found', async () => {
    const agentPage = { ...pageRow, type: 'AI_CHAT' };
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(agentPage as never);

    const result = await pageRepository.findAgentById('agent-1');
    expect(result?.type).toBe('AI_CHAT');
  });

  it('returns falsy when agent not found', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

    const result = await pageRepository.findAgentById('nonexistent');
    expect(result).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// existsInDrive
// ---------------------------------------------------------------------------
describe('pageRepository.existsInDrive', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns true when page exists in drive', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue({ id: 'page-1' } as never);

    const result = await pageRepository.existsInDrive('page-1', 'drive-1');
    expect(result).toBe(true);
  });

  it('returns false when page not found in drive', async () => {
    vi.mocked(db.query.pages.findFirst).mockResolvedValue(undefined as never);

    const result = await pageRepository.existsInDrive('nonexistent', 'drive-1');
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getNextPosition
// ---------------------------------------------------------------------------
describe('pageRepository.getNextPosition', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 1 when no siblings exist', async () => {
    const orderByFn = vi.fn().mockResolvedValue([]);
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);

    const result = await pageRepository.getNextPosition('drive-1', null);
    expect(result).toBe(1);
  });

  it('returns max position + 1 when siblings exist', async () => {
    const siblings = [{ position: 5 }, { position: 3 }];
    const orderByFn = vi.fn().mockResolvedValue(siblings);
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);

    const result = await pageRepository.getNextPosition('drive-1', null);
    expect(result).toBe(6);
  });

  it('handles parentId when provided', async () => {
    const orderByFn = vi.fn().mockResolvedValue([{ position: 2 }]);
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);

    const result = await pageRepository.getNextPosition('drive-1', 'parent-1');
    expect(result).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------
describe('pageRepository.create', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns created page with id, title, and type', async () => {
    const newPage = { id: 'new-page', title: 'New Page', type: 'DOCUMENT' };
    setupInsertChain(newPage);

    const result = await pageRepository.create({
      title: 'New Page',
      type: 'DOCUMENT',
      content: '<p></p>',
      driveId: 'drive-1',
      parentId: null,
      position: 1,
    });

    expect(result).toEqual(newPage);
  });

  it('uses default values when optional fields omitted', async () => {
    const newPage = { id: 'new-page', title: 'New Page', type: 'DOCUMENT' };
    const { valuesFn } = setupInsertChain(newPage);

    await pageRepository.create({
      title: 'New Page',
      type: 'DOCUMENT',
      content: '<p></p>',
      driveId: 'drive-1',
      parentId: null,
      position: 1,
    });

    expect(valuesFn).toHaveBeenCalledWith(expect.objectContaining({
      contentMode: 'html',
      isTrashed: false,
      revision: 0,
      stateHash: null,
    }));
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------
describe('pageRepository.update', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns updated page', async () => {
    const updated = { id: 'page-1', title: 'Updated', type: 'DOCUMENT', parentId: null };
    setupUpdateChain([updated]);

    const result = await pageRepository.update('page-1', { title: 'Updated' });
    expect(result).toEqual(updated);
  });

  it('sets updatedAt when not provided', async () => {
    const { setFn } = setupUpdateChain([{ id: 'page-1', title: 'Page', type: 'DOCUMENT', parentId: null }]);

    await pageRepository.update('page-1', { title: 'Page' });

    const updateData = setFn.mock.calls[0][0] as { updatedAt: Date };
    expect(updateData.updatedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// trash
// ---------------------------------------------------------------------------
describe('pageRepository.trash', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls update with isTrashed=true', async () => {
    const setFn = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);

    await pageRepository.trash('page-1');
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ isTrashed: true }));
  });
});

// ---------------------------------------------------------------------------
// trashMany
// ---------------------------------------------------------------------------
describe('pageRepository.trashMany', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls update with isTrashed=true for multiple pages', async () => {
    const setFn = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setFn } as unknown as ReturnType<typeof db.update>);

    await pageRepository.trashMany('drive-1', ['page-1', 'page-2', 'page-3']);
    expect(db.update).toHaveBeenCalled();
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({ isTrashed: true }));
  });
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------
describe('pageRepository.restore', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns restored page', async () => {
    const restored = { id: 'page-1', title: 'My Page', type: 'DOCUMENT', parentId: null };
    setupUpdateChain([restored]);

    const result = await pageRepository.restore('page-1');
    expect(result).toEqual(restored);
  });

  it('calls update with isTrashed=false', async () => {
    const { setFn } = setupUpdateChain([{ id: 'page-1', title: 'My Page', type: 'DOCUMENT', parentId: null }]);

    await pageRepository.restore('page-1');
    expect(setFn).toHaveBeenCalledWith(expect.objectContaining({
      isTrashed: false,
      trashedAt: null,
    }));
  });
});

// ---------------------------------------------------------------------------
// getChildIds
// ---------------------------------------------------------------------------
describe('pageRepository.getChildIds', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns empty array when no children', async () => {
    const whereFn = vi.fn().mockResolvedValue([]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as unknown as ReturnType<typeof db.select>);

    const result = await pageRepository.getChildIds('drive-1', 'page-1');
    expect(result).toEqual([]);
  });

  it('returns direct child IDs', async () => {
    // First call: returns direct children. Subsequent calls for recursion: empty.
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'child-1' }, { id: 'child-2' }]),
        }),
      } as unknown as unknown as ReturnType<typeof db.select>)
      // child-1 has no children
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      } as unknown as unknown as ReturnType<typeof db.select>)
      // child-2 has no children
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      } as unknown as unknown as ReturnType<typeof db.select>);

    const result = await pageRepository.getChildIds('drive-1', 'page-1');
    expect(result).toEqual(['child-1', 'child-2']);
  });

  it('returns all descendant IDs recursively', async () => {
    // page-1 -> child-1 -> grandchild-1
    vi.mocked(db.select)
      // page-1's direct children
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'child-1' }]),
        }),
      } as unknown as unknown as ReturnType<typeof db.select>)
      // child-1's children
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'grandchild-1' }]),
        }),
      } as unknown as unknown as ReturnType<typeof db.select>)
      // grandchild-1's children (none)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      } as unknown as unknown as ReturnType<typeof db.select>);

    const result = await pageRepository.getChildIds('drive-1', 'page-1');
    expect(result).toContain('child-1');
    expect(result).toContain('grandchild-1');
    expect(result).toHaveLength(2);
  });
});
