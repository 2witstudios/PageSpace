import { describe, it, expect, vi, beforeEach } from 'vitest';

const { decryptUserRowMock, warnMock } = vi.hoisted(() => ({
  decryptUserRowMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/user-repository', () => ({
  decryptUserRow: decryptUserRowMock,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { warn: warnMock } },
}));

import { decryptTaskUserRelations, decryptTaskUserRelationsOne } from '../decrypt-task-relations';

describe('decryptTaskUserRelations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Simulate decryption: strip an "enc:" ciphertext marker off `name`/`email`.
    decryptUserRowMock.mockImplementation(async (row: { name?: string | null; email?: string | null }) => ({
      ...row,
      name: typeof row.name === 'string' ? row.name.replace(/^enc:/, '') : row.name,
      email: typeof row.email === 'string' ? row.email.replace(/^enc:/, '') : row.email,
    }));
  });

  it('returns an empty array unchanged and skips the decrypt call', async () => {
    const result = await decryptTaskUserRelations([]);
    expect(result).toEqual([]);
    expect(decryptUserRowMock).not.toHaveBeenCalled();
  });

  it('passes through a task with no assignee/user/assignees relations', async () => {
    const task = { id: 't1', status: 'pending' };
    const result = await decryptTaskUserRelations([task]);
    expect(result).toEqual([task]);
    expect(decryptUserRowMock).not.toHaveBeenCalled();
  });

  it('decrypts assignee, user, and assignees[].user, leaving other fields intact', async () => {
    const task = {
      id: 't1',
      status: 'pending',
      assignee: { id: 'u1', name: 'enc:Alice', image: 'a.png' },
      user: { id: 'u2', name: 'enc:Bob', image: 'b.png' },
      assignees: [
        { userId: 'u3', user: { id: 'u3', name: 'enc:Carol', image: 'c.png' } },
        { userId: null, user: null, agentPageId: 'agent1' },
      ],
    };

    const [result] = await decryptTaskUserRelations([task]);

    expect(result.status).toBe('pending');
    expect(result.assignee).toEqual({ id: 'u1', name: 'Alice', image: 'a.png' });
    expect(result.user).toEqual({ id: 'u2', name: 'Bob', image: 'b.png' });
    expect(result.assignees[0].user).toEqual({ id: 'u3', name: 'Carol', image: 'c.png' });
    expect(result.assignees[1].user).toBeNull();
    expect(result.assignees[1].agentPageId).toBe('agent1');
  });

  it('decrypts each unique user id exactly once across a batch of tasks', async () => {
    const sharedUser = { id: 'u1', name: 'enc:Shared', image: null };
    const tasks = [
      { id: 't1', assignee: sharedUser },
      { id: 't2', user: sharedUser },
      { id: 't3', assignees: [{ user: sharedUser }] },
    ];

    const results = await decryptTaskUserRelations(tasks);

    expect(decryptUserRowMock).toHaveBeenCalledTimes(1);
    expect(results[0]?.assignee?.name).toBe('Shared');
    expect(results[1]?.user?.name).toBe('Shared');
    expect(results[2]?.assignees?.[0].user?.name).toBe('Shared');
  });

  it('preserves each relation\'s own column shape when the same user is selected with different projections', async () => {
    // fetchEnrichedTasks selects assignee={id,name,image} but assignees[].user={id,name}:
    // the wide projection must keep `image`, and the narrow one must not gain fields.
    const tasks = [
      { id: 't1', assignees: [{ user: { id: 'u1', name: 'enc:Alice' } }] },
      { id: 't2', assignee: { id: 'u1', name: 'enc:Alice', image: 'a.png', email: 'enc:a@x.io' } },
    ];

    const results = await decryptTaskUserRelations(tasks);

    expect(decryptUserRowMock).toHaveBeenCalledTimes(1);
    expect(results[1]?.assignee).toEqual({ id: 'u1', name: 'Alice', image: 'a.png', email: 'a@x.io' });
    // Narrow projection: decrypted name, and no image/email keys leak in from the merge.
    expect(results[0]?.assignees?.[0].user).toEqual({ id: 'u1', name: 'Alice' });
  });

  it('tolerates a user relation with no email field (task queries only select id/name/image)', async () => {
    const task = { id: 't1', assignee: { id: 'u1', name: 'enc:Alice', image: null } };
    const [result] = await decryptTaskUserRelations([task]);
    expect(result.assignee).toEqual({ id: 'u1', name: 'Alice', image: null });
    expect((result.assignee as { email?: string }).email).toBeUndefined();
  });

  it('passes through null assignee/user without invoking decrypt for them', async () => {
    const task = { id: 't1', assignee: null, user: null, assignees: [] };
    const [result] = await decryptTaskUserRelations([task]);
    expect(result.assignee).toBeNull();
    expect(result.user).toBeNull();
    expect(result.assignees).toEqual([]);
    expect(decryptUserRowMock).not.toHaveBeenCalled();
  });

  it('falls back to the stored value for a user whose decrypt fails, without failing the batch', async () => {
    decryptUserRowMock.mockImplementation(async (row: { id?: string; name?: string | null }) => {
      if (row.id === 'u-corrupt') throw new Error('Decryption failed');
      return { ...row, name: typeof row.name === 'string' ? row.name.replace(/^enc:/, '') : row.name };
    });
    const tasks = [
      { id: 't1', assignee: { id: 'u-corrupt', name: 'enc:Garbled' } },
      { id: 't2', assignee: { id: 'u-ok', name: 'enc:Bob' } },
    ];

    const results = await decryptTaskUserRelations(tasks);

    expect(results[0]?.assignee?.name).toBe('enc:Garbled');
    expect(results[1]?.assignee?.name).toBe('Bob');
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('decrypt failed'),
      expect.objectContaining({ userId: 'u-corrupt' }),
    );
  });
});

describe('decryptTaskUserRelationsOne', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decryptUserRowMock.mockImplementation(async (row: { name?: string | null }) => ({
      ...row,
      name: typeof row.name === 'string' ? row.name.replace(/^enc:/, '') : row.name,
    }));
  });

  it('decrypts a single task', async () => {
    const result = await decryptTaskUserRelationsOne({ id: 't1', assignee: { id: 'u1', name: 'enc:Alice' } });
    expect(result.assignee?.name).toBe('Alice');
  });

  it('passes through null and undefined', async () => {
    expect(await decryptTaskUserRelationsOne(null)).toBeNull();
    expect(await decryptTaskUserRelationsOne(undefined)).toBeUndefined();
    expect(decryptUserRowMock).not.toHaveBeenCalled();
  });
});
