import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('@pagespace/db/db', () => ({ db: mockDb }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn((a, b) => ({ op: 'eq', a, b })) }));
vi.mock('@pagespace/db/schema/core', () => ({
  drives: { id: 'drives.id', ownerId: 'drives.ownerId', orgId: 'drives.orgId' },
}));

import {
  payerForDrive,
  resolveSessionPayer,
  resolveEnvPayer,
  requireUserPayer,
  lookupDriveBillingFacts,
  ORG_BILLING_PENDING,
  type DriveBillingFacts,
} from '../sandbox-payer';

const personal = (ownerId: string): DriveBillingFacts => ({ ownerId, orgId: null });
const inOrg = (ownerId: string, orgId: string): DriveBillingFacts => ({ ownerId, orgId });

describe('payerForDrive', () => {
  it('WAL-9 (partial) an org drive bills the org, never its lead', () => {
    expect(payerForDrive(inOrg('lead-marcus', 'org-northwind'))).toEqual({ kind: 'org', orgId: 'org-northwind' });
  });

  it('WAL-9 (partial) a personal drive bills its owner', () => {
    expect(payerForDrive(personal('owner-1'))).toEqual({ kind: 'user', userId: 'owner-1' });
  });
});

/**
 * The ENV payer, tested directly rather than only through the reconcile.
 *
 * The rule is the whole of an env's billing correctness: the DRIVE's payer, or nobody.
 * `drive_envs.createdBy` is audit only, and a future `?? createdBy` — or any other fallback
 * added in sympathy with the session resolver next door — must fail HERE, at the seam that
 * states the rule, not only somewhere downstream that happens to exercise it.
 */
describe('resolveEnvPayer', () => {
  it('resolves the drive owner for a personal drive', async () => {
    const payer = await resolveEnvPayer({
      driveId: 'drive-1',
      lookupDriveBillingFacts: async (driveId) => personal(`owner-of-${driveId}`),
    });

    expect(payer).toEqual({ kind: 'user', userId: 'owner-of-drive-1' });
  });

  it('WAL-9 (partial) an env in an org drive is billed to the org', async () => {
    const payer = await resolveEnvPayer({
      driveId: 'drive-1',
      lookupDriveBillingFacts: async () => inOrg('lead-marcus', 'org-northwind'),
    });

    expect(payer).toEqual({ kind: 'org', orgId: 'org-northwind' });
  });

  it('returns NULL when the drive cannot be resolved — there is no fallback, by design', async () => {
    // The deliberate divergence from `resolveSessionPayer`, which falls back to the session's
    // own owner. An env has no owner column to fall back to, and inventing one would bill a
    // drive-owned machine to somebody who does not own it. Callers SKIP the cycle instead.
    const payer = await resolveEnvPayer({ driveId: 'drive-gone', lookupDriveBillingFacts: async () => null });

    expect(payer).toBeNull();
  });
});

describe('resolveSessionPayer', () => {
  it('bills the session owner directly for a global-assistant session (driveId null), with no lookup', async () => {
    const lookup = vi.fn();
    await expect(
      resolveSessionPayer({ driveId: null, ownerId: 'owner-1', lookupDriveBillingFacts: lookup }),
    ).resolves.toEqual({ kind: 'user', userId: 'owner-1' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resolves to the session's ACTUAL drive owner when driveId is set — never the caller's surface tenant", async () => {
    const lookup = vi.fn(async () => personal('real-drive-owner'));
    await expect(
      resolveSessionPayer({ driveId: 'session-drive-1', ownerId: 'session-owner-1', lookupDriveBillingFacts: lookup }),
    ).resolves.toEqual({ kind: 'user', userId: 'real-drive-owner' });
    expect(lookup).toHaveBeenCalledWith('session-drive-1');
  });

  it('WAL-9 (partial) a session in an org drive is billed to the org, not the drive lead or the session owner', async () => {
    await expect(
      resolveSessionPayer({
        driveId: 'org-drive',
        ownerId: 'session-owner-1',
        lookupDriveBillingFacts: async () => inOrg('lead-marcus', 'org-northwind'),
      }),
    ).resolves.toEqual({ kind: 'org', orgId: 'org-northwind' });
  });

  it('falls back to the session ownerId when the drive lookup finds nothing (a stale read mid-delete)', async () => {
    await expect(
      resolveSessionPayer({ driveId: 'vanished-drive', ownerId: 'owner-1', lookupDriveBillingFacts: async () => null }),
    ).resolves.toEqual({ kind: 'user', userId: 'owner-1' });
  });

  it('is not a passthrough — a resolved drive owner beats a different session ownerId', async () => {
    const lookup = vi.fn(async () => personal('other-owner'));
    const a = await resolveSessionPayer({ driveId: 'd', ownerId: 'a', lookupDriveBillingFacts: lookup });
    const b = await resolveSessionPayer({ driveId: 'd', ownerId: 'b', lookupDriveBillingFacts: lookup });
    expect(a).toEqual({ kind: 'user', userId: 'other-owner' });
    expect(b).toEqual({ kind: 'user', userId: 'other-owner' });
  });
});

describe('requireUserPayer (the interim until org wallets can be charged)', () => {
  it('passes a person through', () => {
    expect(requireUserPayer({ kind: 'user', userId: 'owner-1' })).toEqual({ ok: true, userId: 'owner-1' });
  });

  it('WAL-9 (partial) refuses an org payer by name — it never substitutes a person', () => {
    const result = requireUserPayer({ kind: 'org', orgId: 'org-northwind' });
    expect(result).toEqual({
      ok: false,
      refusal: { code: ORG_BILLING_PENDING, orgId: 'org-northwind', message: expect.any(String) },
    });
    expect(ORG_BILLING_PENDING).toBe('org_billing_pending');
  });
});

describe('lookupDriveBillingFacts (real drives read)', () => {
  beforeEach(() => mockDb.select.mockReset());

  it("returns the drive's ownerId and orgId", async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [{ ownerId: 'owner-42', orgId: 'org-7' }],
        }),
      }),
    });
    await expect(lookupDriveBillingFacts('drive-1')).resolves.toEqual({ ownerId: 'owner-42', orgId: 'org-7' });
  });

  it('returns null when the drive has no row', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    });
    await expect(lookupDriveBillingFacts('missing')).resolves.toBeNull();
  });
});
