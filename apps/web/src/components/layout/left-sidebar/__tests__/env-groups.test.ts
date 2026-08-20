/**
 * The environment partition's three load-bearing rules: an empty environment
 * still exists, a session is never dropped, and the ordering is the drive
 * listing's own name order.
 */
import { describe, it, expect } from 'vitest';
import { partitionSessionsByEnv } from '../env-groups';
import type { DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';

const env = (over: Partial<DriveEnvDTO> & { id: string; name: string }): DriveEnvDTO => ({
  driveId: 'drive-1',
  status: 'none',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const session = (workspaceId: string, envId: string | null) => ({ workspaceId, envId });

describe('partitionSessionsByEnv', () => {
  it('given an environment with no sessions, should still render a group — infrastructure is not ephemera', () => {
    const r = partitionSessionsByEnv([], [env({ id: 'env-1', name: 'staging' })]);
    expect(r.envGroups).toHaveLength(1);
    expect(r.envGroups[0]).toMatchObject({ envId: 'env-1', envName: 'staging', sessions: [] });
    expect(r.looseSessions).toEqual([]);
  });

  it('given env-bound and loose sessions, should nest the bound ones and leave the rest at drive level', () => {
    const r = partitionSessionsByEnv(
      [session('a', 'env-1'), session('b', null), session('c', 'env-1')],
      [env({ id: 'env-1', name: 'staging' })],
    );
    expect(r.envGroups[0].sessions.map((s) => s.workspaceId)).toEqual(['a', 'c']);
    expect(r.looseSessions.map((s) => s.workspaceId)).toEqual(['b']);
  });

  it('given a session naming an environment the listing omitted, should surface it as an orphan rather than drop it', () => {
    const r = partitionSessionsByEnv([session('a', 'env-missing')], []);
    expect(r.looseSessions).toEqual([]);
    expect(r.envGroups).toHaveLength(1);
    expect(r.envGroups[0]).toMatchObject({ envId: 'env-missing', envName: null, status: null });
    expect(r.envGroups[0].sessions.map((s) => s.workspaceId)).toEqual(['a']);
  });

  it('orders listed environments by name and puts orphans last', () => {
    const r = partitionSessionsByEnv(
      [session('a', 'env-orphan')],
      [env({ id: 'env-z', name: 'zebra' }), env({ id: 'env-a', name: 'alpha' })],
    );
    expect(r.envGroups.map((g) => g.envId)).toEqual(['env-a', 'env-z', 'env-orphan']);
  });

  it('carries each environment’s derived status through, so the row can render a dot without a second lookup', () => {
    const r = partitionSessionsByEnv([], [env({ id: 'env-1', name: 'staging', status: 'running' })]);
    expect(r.envGroups[0].status).toBe('running');
  });
});
