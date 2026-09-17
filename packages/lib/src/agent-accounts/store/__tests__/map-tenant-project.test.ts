/**
 * ADR 0005 §3.1 — RED at G1b-store before `map-tenant-project.ts` existed.
 */
import { describe, it, expect } from 'vitest';
import type { TenantId } from '@pagespace/db/schema/agent-accounts';
import { mapTenantProject } from '../map-tenant-project';

const fakeHash = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .reduce((acc, byte) => acc + byte, 0)
    .toString(16)
    .padStart(32, '0');

describe('mapTenantProject', () => {
  it('given a tenant id, should return a deterministic project slug', () => {
    const tenantId = 'user:u1' as TenantId;
    const actual = mapTenantProject({ tenantId, hash: fakeHash });
    expect(actual).toEqual({ tenantId, projectSlug: `pgsp-${fakeHash(new TextEncoder().encode(tenantId))}` });
  });

  it('given two different tenant ids, should return different project slugs', () => {
    const a = mapTenantProject({ tenantId: 'user:u1' as TenantId, hash: (b) => Buffer.from(b).toString('hex') });
    const b = mapTenantProject({ tenantId: 'user:u2' as TenantId, hash: (b) => Buffer.from(b).toString('hex') });
    expect(a.projectSlug).not.toBe(b.projectSlug);
  });

  it('given the same tenant id twice, should return the same slug (pure)', () => {
    const tenantId = 'drive:d1' as TenantId;
    const actual = [mapTenantProject({ tenantId, hash: fakeHash }), mapTenantProject({ tenantId, hash: fakeHash })];
    expect(actual[0]).toEqual(actual[1]);
  });
});
