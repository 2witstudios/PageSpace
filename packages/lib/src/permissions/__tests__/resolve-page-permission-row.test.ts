/**
 * The page-access decision, tested without a database.
 *
 * This function exists so the two directions of the same question resolve
 * identically: getBatchPagePermissions ("which pages can this user see?") and
 * getUsersWhoCanViewPage ("which users can see this page?"). They previously
 * had separate implementations and drifted — the channel inbox fan-out knew
 * about owners, admins and explicit grants but not rule 4 or custom roles, so
 * ordinary members of a public channel were silently dropped from fan-out.
 *
 * These cases pin the precedence order, which is what a second implementation
 * gets wrong first.
 */
import { describe, it, expect } from 'vitest';
import { resolvePagePermissionRow, type PagePermissionRow } from '../permissions';

const USER = 'user_me';
const OTHER = 'user_other';

const row = (overrides: Partial<PagePermissionRow> = {}): PagePermissionRow => ({
  pageId: 'page_1',
  isTrashed: false,
  isPrivate: false,
  pageType: 'CHANNEL',
  driveOwnerId: OTHER,
  memberRole: null,
  explicitCanView: null,
  explicitCanEdit: null,
  explicitCanShare: null,
  explicitCanDelete: null,
  customRolePerms: null,
  customRoleDriveWidePerms: null,
  ...overrides,
});

describe('resolvePagePermissionRow', () => {
  it('grants nothing on a trashed page, whoever is asking', () => {
    expect(resolvePagePermissionRow(row({ isTrashed: true, driveOwnerId: USER }), USER)).toBeNull();
  });

  it('gives the drive owner everything', () => {
    expect(resolvePagePermissionRow(row({ driveOwnerId: USER }), USER)).toEqual({
      canView: true, canEdit: true, canShare: true, canDelete: true,
    });
  });

  it('gives a drive admin everything', () => {
    expect(resolvePagePermissionRow(row({ memberRole: 'ADMIN' }), USER)).toEqual({
      canView: true, canEdit: true, canShare: true, canDelete: true,
    });
  });

  // Rule 4 — the case the fan-out's hand-written copy was missing.
  it('lets an accepted member view a non-private page with no explicit grant', () => {
    const resolved = resolvePagePermissionRow(row({ memberRole: 'MEMBER' }), USER);
    expect(resolved?.canView).toBe(true);
  });

  it('lets an accepted member post in a channel but not in other page types', () => {
    expect(resolvePagePermissionRow(row({ memberRole: 'MEMBER' }), USER)?.canEdit).toBe(true);
    expect(
      resolvePagePermissionRow(row({ memberRole: 'MEMBER', pageType: 'DOCUMENT' }), USER)?.canEdit
    ).toBe(false);
  });

  it('does not let a member view a PRIVATE page without a grant', () => {
    expect(resolvePagePermissionRow(row({ memberRole: 'MEMBER', isPrivate: true }), USER)).toBeNull();
  });

  it('grants nothing to a non-member with no grant', () => {
    expect(resolvePagePermissionRow(row(), USER)).toBeNull();
  });

  it('grants nothing to an unaccepted invitee (memberRole is null until accepted)', () => {
    // getBatchPagePermissions joins driveMembers on acceptedAt IS NOT NULL, so a
    // pending invite arrives here as memberRole: null.
    expect(resolvePagePermissionRow(row({ memberRole: null }), USER)).toBeNull();
  });

  describe('precedence', () => {
    it('an explicit deny overrides rule 4 for a member of a non-private page', () => {
      const resolved = resolvePagePermissionRow(
        row({ memberRole: 'MEMBER', explicitCanView: false }),
        USER
      );
      expect(resolved).toEqual({
        canView: false, canEdit: false, canShare: false, canDelete: false,
      });
    });

    it('an explicit grant opens a private page to a member', () => {
      const resolved = resolvePagePermissionRow(
        row({ memberRole: 'MEMBER', isPrivate: true, explicitCanView: true }),
        USER
      );
      expect(resolved?.canView).toBe(true);
    });

    it('owner/admin beats an explicit deny', () => {
      expect(
        resolvePagePermissionRow(row({ driveOwnerId: USER, explicitCanView: false }), USER)?.canView
      ).toBe(true);
      expect(
        resolvePagePermissionRow(row({ memberRole: 'ADMIN', explicitCanView: false }), USER)?.canView
      ).toBe(true);
    });

    it('a custom role decides before rule 4 falls back', () => {
      const resolved = resolvePagePermissionRow(
        row({
          memberRole: 'MEMBER',
          isPrivate: true,
          customRolePerms: { page_1: { canView: true, canEdit: false, canShare: false } },
        }),
        USER
      );
      expect(resolved?.canView).toBe(true);
      // Custom roles never confer delete.
      expect(resolved?.canDelete).toBe(false);
    });

    it('falls back to the custom role drive-wide grant when the page has no entry', () => {
      // resolveCustomRolePermissions takes two inputs — the per-page entry and
      // the drive-wide default. Only the former is exercised above, and the
      // fallback is the half a second implementation is likeliest to drop.
      const resolved = resolvePagePermissionRow(
        row({
          memberRole: 'MEMBER',
          isPrivate: true,
          customRolePerms: {},
          customRoleDriveWidePerms: { canView: true, canEdit: true, canShare: false },
        }),
        USER
      );
      expect(resolved?.canView).toBe(true);
      expect(resolved?.canEdit).toBe(true);
      expect(resolved?.canDelete).toBe(false);
    });
  });
});
