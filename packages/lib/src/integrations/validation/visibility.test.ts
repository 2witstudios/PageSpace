/**
 * Pure Visibility Check Tests
 */

import { describe, it, expect } from 'vitest';
import { isUserIntegrationVisibleInDrive } from './visibility';

describe('isUserIntegrationVisibleInDrive', () => {
  describe('private visibility', () => {
    it('given visibility private, should return false for all drives', () => {
      expect(isUserIntegrationVisibleInDrive('private', 'OWNER')).toBe(false);
      expect(isUserIntegrationVisibleInDrive('private', 'ADMIN')).toBe(false);
      expect(isUserIntegrationVisibleInDrive('private', 'MEMBER')).toBe(false);
      expect(isUserIntegrationVisibleInDrive('private', null)).toBe(false);
    });
  });

  describe('owned_drives visibility', () => {
    it('given visibility owned_drives and role OWNER, should return true', () => {
      expect(isUserIntegrationVisibleInDrive('owned_drives', 'OWNER')).toBe(true);
    });

    it('given visibility owned_drives and role ADMIN, should return true', () => {
      expect(isUserIntegrationVisibleInDrive('owned_drives', 'ADMIN')).toBe(true);
    });

    it('given visibility owned_drives and role MEMBER, should return false', () => {
      expect(isUserIntegrationVisibleInDrive('owned_drives', 'MEMBER')).toBe(false);
    });

    it('given visibility owned_drives and no role, should return false', () => {
      expect(isUserIntegrationVisibleInDrive('owned_drives', null)).toBe(false);
    });
  });

  describe('all_drives visibility', () => {
    it('given visibility all_drives and any role, should return true', () => {
      expect(isUserIntegrationVisibleInDrive('all_drives', 'OWNER')).toBe(true);
      expect(isUserIntegrationVisibleInDrive('all_drives', 'ADMIN')).toBe(true);
      expect(isUserIntegrationVisibleInDrive('all_drives', 'MEMBER')).toBe(true);
    });

    it('given visibility all_drives and no role, should return false', () => {
      expect(isUserIntegrationVisibleInDrive('all_drives', null)).toBe(false);
    });
  });
});
