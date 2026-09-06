/**
 * The environment partition's three load-bearing rules: an empty environment
 * still exists, a session is never dropped, and the ordering is the drive
 * listing's own name order.
 */
import { describe, it, expect } from 'vitest';
import { partitionSessionsByEnv } from '../env-groups';
import type { DriveEnvDTO } from '@pagespace/lib/drive-envs/env-contract';

type SpriteEnvDTO = Extract<DriveEnvDTO, { substrate: 'sprite' }>;

/** A Sprite env DTO; the partition is substrate-agnostic, so Sprite is a fine default. */
const env = (over: Partial<SpriteEnvDTO> & { id: string; name: string }): DriveEnvDTO => ({
  driveId: 'drive-1',
  substrate: 'sprite',
  status: 'none',
  createdAt: '2026-08-01T00:00:00.000Z',
  ...over,
});

const session = (workspaceId: string, envId: string | null) => ({ workspaceId, envId });

describe('partitionSessionsByEnv — the substrate rides along', () => {
  it('given a local env, should carry substrate local on its group so the row can withhold Sprite-only actions; an orphan carries null', () => {
    const local: DriveEnvDTO = { id: 'env-l', driveId: 'drive-1', name: 'mac', substrate: 'local', status: 'disconnected', label: 'jono-macstudio', createdAt: '2026-08-01T00:00:00.000Z' };
    const r = partitionSessionsByEnv([session('x', 'env-ghost')], [env({ id: 'env-s', name: 'cloud' }), local]);
    expect(r.envGroups.map((g) => [g.envId, g.substrate])).toEqual([
      ['env-s', 'sprite'],
      ['env-l', 'local'],
      ['env-ghost', null],
    ]);
  });
});

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
