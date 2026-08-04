import { describe, it, expect } from 'vitest';
import { computeSandboxEligibilityByDrive, resolveEditableDriveIds } from '../sandbox-eligibility-by-drive';

/** An actor who can edit everywhere it matters — the default for payer-tier-focused cases. */
function editorOf(...driveIds: string[]) {
  return { userId: 'requester-1', editableDriveIds: new Set(driveIds), codeExecutionEnabled: true };
}

describe('computeSandboxEligibilityByDrive', () => {
  it('marks a drive eligible when its owner is on a paying tier and the requester can edit it', () => {
    const result = computeSandboxEligibilityByDrive(
      [{ id: 'drive-1', ownerId: 'owner-1' }],
      [{ id: 'owner-1', subscriptionTier: 'pro' }],
      editorOf('drive-1'),
    );
    expect(result.get('drive-1')).toBe(true);
  });

  it('marks a drive ineligible when its owner is free-tier', () => {
    const result = computeSandboxEligibilityByDrive(
      [{ id: 'drive-1', ownerId: 'owner-1' }],
      [{ id: 'owner-1', subscriptionTier: 'free' }],
      editorOf('drive-1'),
    );
    expect(result.get('drive-1')).toBe(false);
  });

  it('defaults to free (ineligible) when the owner row is missing entirely', () => {
    const result = computeSandboxEligibilityByDrive(
      [{ id: 'drive-1', ownerId: 'owner-missing' }],
      [],
      editorOf('drive-1'),
    );
    expect(result.get('drive-1')).toBe(false);
  });

  it('coerces an unrecognized/malformed tier string to free (ineligible), never throws', () => {
    const result = computeSandboxEligibilityByDrive(
      [{ id: 'drive-1', ownerId: 'owner-1' }],
      [{ id: 'owner-1', subscriptionTier: 'not-a-real-tier' }],
      editorOf('drive-1'),
    );
    expect(result.get('drive-1')).toBe(false);
  });

  it('marks a Pro drive ineligible for a VIEWER-role requester — payer tier alone must not advertise shell affordances (review #2326)', () => {
    const result = computeSandboxEligibilityByDrive(
      [{ id: 'drive-1', ownerId: 'owner-1' }],
      [{ id: 'owner-1', subscriptionTier: 'pro' }],
      { userId: 'requester-1', editableDriveIds: new Set(), codeExecutionEnabled: true },
    );
    expect(result.get('drive-1')).toBe(false);
  });

  it("treats the requester's OWN drive as editable without a membership row", () => {
    const result = computeSandboxEligibilityByDrive(
      [{ id: 'drive-1', ownerId: 'requester-1' }],
      [{ id: 'requester-1', subscriptionTier: 'pro' }],
      { userId: 'requester-1', editableDriveIds: new Set(), codeExecutionEnabled: true },
    );
    expect(result.get('drive-1')).toBe(true);
  });

  it('marks everything ineligible while the code-execution kill switch is off', () => {
    const result = computeSandboxEligibilityByDrive(
      [{ id: 'drive-1', ownerId: 'owner-1' }],
      [{ id: 'owner-1', subscriptionTier: 'business' }],
      { userId: 'requester-1', editableDriveIds: new Set(['drive-1']), codeExecutionEnabled: false },
    );
    expect(result.get('drive-1')).toBe(false);
  });

  it('resolves each drive independently — a free-tier owner does not poison a co-owned Pro drive, or vice versa', () => {
    const result = computeSandboxEligibilityByDrive(
      [
        { id: 'drive-free', ownerId: 'owner-free' },
        { id: 'drive-pro', ownerId: 'owner-pro' },
      ],
      [
        { id: 'owner-free', subscriptionTier: 'free' },
        { id: 'owner-pro', subscriptionTier: 'pro' },
      ],
      editorOf('drive-free', 'drive-pro'),
    );
    expect(result.get('drive-free')).toBe(false);
    expect(result.get('drive-pro')).toBe(true);
  });

  it('dedupes correctly when several drives share the same owner — one owner row covers them all', () => {
    const result = computeSandboxEligibilityByDrive(
      [
        { id: 'drive-a', ownerId: 'owner-1' },
        { id: 'drive-b', ownerId: 'owner-1' },
        { id: 'drive-c', ownerId: 'owner-1' },
      ],
      [{ id: 'owner-1', subscriptionTier: 'business' }],
      editorOf('drive-a', 'drive-b', 'drive-c'),
    );
    expect(result.get('drive-a')).toBe(true);
    expect(result.get('drive-b')).toBe(true);
    expect(result.get('drive-c')).toBe(true);
  });

  it('mixes the axes per drive — editable Pro yes, viewer Pro no, editable Free no', () => {
    const result = computeSandboxEligibilityByDrive(
      [
        { id: 'drive-editable-pro', ownerId: 'owner-pro' },
        { id: 'drive-viewer-pro', ownerId: 'owner-pro' },
        { id: 'drive-editable-free', ownerId: 'owner-free' },
      ],
      [
        { id: 'owner-pro', subscriptionTier: 'pro' },
        { id: 'owner-free', subscriptionTier: 'free' },
      ],
      editorOf('drive-editable-pro', 'drive-editable-free'),
    );
    expect(result.get('drive-editable-pro')).toBe(true);
    expect(result.get('drive-viewer-pro')).toBe(false);
    expect(result.get('drive-editable-free')).toBe(false);
  });

  it('given no drives at all, returns an empty map', () => {
    const result = computeSandboxEligibilityByDrive([], [], editorOf());
    expect(result.size).toBe(0);
  });
});

describe('resolveEditableDriveIds', () => {
  const member = (driveId: string, role: string, customRoleId: string | null = null) => ({ driveId, role, customRoleId });

  it('grants plain MEMBER and ADMIN memberships', () => {
    const result = resolveEditableDriveIds([member('d1', 'MEMBER'), member('d2', 'ADMIN')], []);
    expect(result).toEqual(new Set(['d1', 'd2']));
  });

  it('bounds a MEMBER by their custom role: drive-wide canEdit must be explicitly true (codex round 13)', () => {
    const roles = [
      { id: 'r-yes', driveId: 'd1', driveWidePermissions: { canEdit: true } },
      { id: 'r-no', driveId: 'd2', driveWidePermissions: { canEdit: false } },
      { id: 'r-none', driveId: 'd3', driveWidePermissions: null },
    ];
    const result = resolveEditableDriveIds(
      [member('d1', 'MEMBER', 'r-yes'), member('d2', 'MEMBER', 'r-no'), member('d3', 'MEMBER', 'r-none')],
      roles,
    );
    expect(result).toEqual(new Set(['d1']));
  });

  it('fails closed on an unresolvable custom role', () => {
    const result = resolveEditableDriveIds([member('d1', 'MEMBER', 'r-stale')], []);
    expect(result).toEqual(new Set());
  });

  it('never applies a role outside its own drive', () => {
    // The role grants edit, but for a DIFFERENT drive than the membership's.
    const roles = [{ id: 'r1', driveId: 'other-drive', driveWidePermissions: { canEdit: true } }];
    const result = resolveEditableDriveIds([member('d1', 'MEMBER', 'r1')], roles);
    expect(result).toEqual(new Set());
  });

  it('lets an ADMIN bypass their custom role', () => {
    const roles = [{ id: 'r-no', driveId: 'd1', driveWidePermissions: { canEdit: false } }];
    const result = resolveEditableDriveIds([member('d1', 'ADMIN', 'r-no')], roles);
    expect(result).toEqual(new Set(['d1']));
  });
});
