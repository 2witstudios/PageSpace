import { describe, it, expect } from 'vitest';
import { resolveRolePermissions } from '../resolve-role-permissions';

const PAGE_ID = 'page_aaaaaaaaaaaaaaaaaaaaaa';

describe('resolveRolePermissions', () => {
  describe('ADMIN role', () => {
    it('returns full access', () => {
      expect(resolveRolePermissions('ADMIN', null, PAGE_ID)).toEqual({
        canView: true, canEdit: true, canShare: true, canDelete: true,
      });
    });

    it('ignores custom role permissions', () => {
      const perms = { [PAGE_ID]: { canView: false, canEdit: false, canShare: false } };
      expect(resolveRolePermissions('ADMIN', perms, PAGE_ID)).toEqual({
        canView: true, canEdit: true, canShare: true, canDelete: true,
      });
    });
  });

  describe('OWNER role', () => {
    it('returns full access', () => {
      expect(resolveRolePermissions('OWNER', null, PAGE_ID)).toEqual({
        canView: true, canEdit: true, canShare: true, canDelete: true,
      });
    });
  });

  describe('MEMBER role with no custom role', () => {
    it('returns read-only access', () => {
      expect(resolveRolePermissions('MEMBER', null, PAGE_ID)).toEqual({
        canView: true, canEdit: false, canShare: false, canDelete: false,
      });
    });
  });

  describe('MEMBER role with custom role permissions', () => {
    it('returns permissions from custom role when page is in the role', () => {
      const perms = { [PAGE_ID]: { canView: true, canEdit: true, canShare: false } };
      expect(resolveRolePermissions('MEMBER', perms, PAGE_ID)).toEqual({
        canView: true, canEdit: true, canShare: false, canDelete: false,
      });
    });

    it('returns all-false when page is not in the custom role', () => {
      const perms = { 'page_other': { canView: true, canEdit: true, canShare: true } };
      expect(resolveRolePermissions('MEMBER', perms, PAGE_ID)).toEqual({
        canView: false, canEdit: false, canShare: false, canDelete: false,
      });
    });

    it('canDelete is always false even when custom role grants canView/canEdit/canShare', () => {
      const perms = { [PAGE_ID]: { canView: true, canEdit: true, canShare: true } };
      const result = resolveRolePermissions('MEMBER', perms, PAGE_ID);
      expect(result.canDelete).toBe(false);
    });

    it('returns all-false when custom role exists but page permissions are all false', () => {
      const perms = { [PAGE_ID]: { canView: false, canEdit: false, canShare: false } };
      expect(resolveRolePermissions('MEMBER', perms, PAGE_ID)).toEqual({
        canView: false, canEdit: false, canShare: false, canDelete: false,
      });
    });
  });
});
