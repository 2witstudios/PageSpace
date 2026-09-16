/**
 * ADR 0005 §2.2 `put`, §8 F25 (G1c R2, R4) — a put/rotate carries the whole
 * bindings RECORD: its scope must hash to its own policyDigest, its consenters
 * must fit the owner kind, and on an existing ref it must equal the stored
 * record — the pinned consenters included. Written RED before
 * `decide-write-record.ts` exists.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { PolicyVersion, TenantId } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from '../../canonical-request';
import type { HashBytes, UserId } from '../../grant';
import type { PlaneBindingsRecord, PlaneScope } from '../store-adapter';
import { digestPlaneScope } from '../digest-plane-scope';
import { decideWriteRecord } from '../decide-write-record';

const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const API = 'https://api.example:443' as CanonicalOrigin;
const SCOPE: PlaneScope = { approvalPolicy: null, resourceRestrictions: {}, boundAgentPageIds: [], allowedOrigins: [API], auxiliaryOrigins: [], sessionHttpEnabled: false, providerSlug: null };

const USER_RECORD: PlaneBindingsRecord = {
  bindings: { tenantId: 'user:u1' as TenantId, ownerRef: { kind: 'user', userId: 'u1' }, allowedOrigins: [API], policyVersion: 2 as PolicyVersion, policyDigest: digestPlaneScope({ scope: SCOPE, hash: sha3 }), kind: 'api_key' },
  scope: SCOPE,
  consenters: { kind: 'owner' },
};
const PAGE_RECORD: PlaneBindingsRecord = {
  bindings: { ...USER_RECORD.bindings, tenantId: 'drive:d1' as TenantId, ownerRef: { kind: 'agent_page', agentPageId: 'p1', driveId: 'd1' } },
  scope: SCOPE,
  consenters: { kind: 'pinned', userIds: ['admin_a' as UserId, 'admin_b' as UserId] },
};

describe('decideWriteRecord (G1c R2, R4)', () => {
  it('given no stored record (the first put) and a self-consistent record whose consenters fit the owner, should accept and pin it', () => {
    const actual = [decideWriteRecord({ stored: null, written: USER_RECORD, hash: sha3 }), decideWriteRecord({ stored: null, written: PAGE_RECORD, hash: sha3 })];
    expect(actual).toEqual([{ ok: true }, { ok: true }]);
  });

  it('given consenters that do not fit the owner kind, should refuse consenters_invalid — on the first put too', () => {
    const variants: readonly PlaneBindingsRecord[] = [
      { ...USER_RECORD, consenters: { kind: 'pinned', userIds: ['u1' as UserId] } },
      { ...PAGE_RECORD, consenters: { kind: 'owner' } },
      { ...PAGE_RECORD, consenters: { kind: 'pinned', userIds: [] } },
    ];
    const actual = variants.map((written) => decideWriteRecord({ stored: null, written, hash: sha3 }));
    expect(actual).toEqual(variants.map(() => ({ ok: false, reason: 'consenters_invalid' })));
  });

  it('given a scope that does not hash to the bindings policyDigest, or origins that disagree, should refuse version_conflict', () => {
    const variants: readonly PlaneBindingsRecord[] = [
      { ...USER_RECORD, scope: { ...SCOPE, sessionHttpEnabled: true } },
      { ...USER_RECORD, bindings: { ...USER_RECORD.bindings, allowedOrigins: [API, 'https://other.example:443' as CanonicalOrigin] } },
    ];
    const actual = variants.map((written) => decideWriteRecord({ stored: null, written, hash: sha3 }));
    expect(actual).toEqual(variants.map(() => ({ ok: false, reason: 'version_conflict' })));
  });

  it('given an existing ref, should accept only the stored record — the same pinned set in any order, never another set or older bindings', () => {
    const reordered: PlaneBindingsRecord = { ...PAGE_RECORD, consenters: { kind: 'pinned', userIds: ['admin_b' as UserId, 'admin_a' as UserId] } };
    const repinned: PlaneBindingsRecord = { ...PAGE_RECORD, consenters: { kind: 'pinned', userIds: ['attacker' as UserId] } };
    const older: PlaneBindingsRecord = { ...PAGE_RECORD, bindings: { ...PAGE_RECORD.bindings, policyVersion: 1 as PolicyVersion } };
    const actual = [reordered, repinned, older].map((written) => decideWriteRecord({ stored: PAGE_RECORD, written, hash: sha3 }));
    expect(actual).toEqual([{ ok: true }, { ok: false, reason: 'version_conflict' }, { ok: false, reason: 'version_conflict' }]);
  });
});
