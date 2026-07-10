import { describe, it, expect, vi, beforeEach } from 'vitest';

const { decryptUsersByIdOnceMock } = vi.hoisted(() => ({
  decryptUsersByIdOnceMock: vi.fn(),
}));

vi.mock('@pagespace/lib/auth/user-repository', () => ({
  decryptUsersByIdOnce: decryptUsersByIdOnceMock,
}));

import { decryptTaskUserRelations } from '../decrypt-task-relations';

describe('decryptTaskUserRelations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Simulate decryption: strip a "enc:" ciphertext marker off `name`/`email`.
    decryptUsersByIdOnceMock.mockImplementation(async (rows: Array<{ id: string; name?: string | null; email?: string | null }>) => {
      const map = new Map<string, unknown>();
      for (const row of rows) {
        map.set(row.id, {
          ...row,
          name: typeof row.name === 'string' ? row.name.replace(/^enc:/, '') : row.name,
          email: typeof row.email === 'string' ? row.email.replace(/^enc:/, '') : row.email,
        });
      }
      return map;
    });
  });

  it('returns an empty array unchanged and skips the decrypt call', async () => {
    const result = await decryptTaskUserRelations([]);
    expect(result).toEqual([]);
    expect(decryptUsersByIdOnceMock).not.toHaveBeenCalled();
  });

  it('passes through a task with no assignee/user/assignees relations', async () => {
    const task = { id: 't1', status: 'pending' };
    const result = await decryptTaskUserRelations([task]);
    expect(result).toEqual([task]);
    expect(decryptUsersByIdOnceMock).not.toHaveBeenCalled();
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

    expect(decryptUsersByIdOnceMock).toHaveBeenCalledTimes(1);
    expect(decryptUsersByIdOnceMock).toHaveBeenCalledWith([sharedUser, sharedUser, sharedUser]);
    expect(results[0]?.assignee?.name).toBe('Shared');
    expect(results[1]?.user?.name).toBe('Shared');
    expect(results[2]?.assignees?.[0].user?.name).toBe('Shared');
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
    expect(decryptUsersByIdOnceMock).not.toHaveBeenCalled();
  });
});
