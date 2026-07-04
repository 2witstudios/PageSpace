import { describe, it, expect } from 'vitest';
import { isToastEligible, TOAST_EXCLUDED_TYPES, TOAST_HIGH_SIGNAL_TYPES } from '../toast-eligible-types';
import type { NotificationType } from '@pagespace/lib/notifications/types';

const ALL_TYPES: NotificationType[] = [
  'CONNECTION_REQUEST',
  'CONNECTION_ACCEPTED',
  'CONNECTION_REJECTED',
  'NEW_DIRECT_MESSAGE',
  'PERMISSION_GRANTED',
  'PERMISSION_UPDATED',
  'PERMISSION_REVOKED',
  'PAGE_SHARED',
  'DRIVE_INVITED',
  'DRIVE_JOINED',
  'DRIVE_ROLE_CHANGED',
  'EMAIL_VERIFICATION_REQUIRED',
  'TOS_PRIVACY_UPDATED',
  'MENTION',
  'TASK_ASSIGNED',
];

describe('isToastEligible', () => {
  describe('level: off', () => {
    it('excludes every type, including otherwise-eligible ones', () => {
      for (const type of ALL_TYPES) {
        expect(isToastEligible(type, 'off')).toBe(false);
      }
    });
  });

  describe('level: all (default)', () => {
    it('excludes EMAIL_VERIFICATION_REQUIRED and TOS_PRIVACY_UPDATED', () => {
      expect(isToastEligible('EMAIL_VERIFICATION_REQUIRED', 'all')).toBe(false);
      expect(isToastEligible('TOS_PRIVACY_UPDATED', 'all')).toBe(false);
    });

    it('includes every other type', () => {
      for (const type of ALL_TYPES) {
        if (TOAST_EXCLUDED_TYPES.has(type)) continue;
        expect(isToastEligible(type, 'all')).toBe(true);
      }
    });

    it('defaults to level all when no level argument is passed', () => {
      expect(isToastEligible('MENTION')).toBe(true);
      expect(isToastEligible('TOS_PRIVACY_UPDATED')).toBe(false);
    });
  });

  describe('level: mentions', () => {
    it('includes only the high-signal types', () => {
      for (const type of TOAST_HIGH_SIGNAL_TYPES) {
        expect(isToastEligible(type, 'mentions')).toBe(true);
      }
    });

    it('excludes non-high-signal, non-excluded types', () => {
      const nonHighSignal = ALL_TYPES.filter(
        (type) => !TOAST_HIGH_SIGNAL_TYPES.has(type) && !TOAST_EXCLUDED_TYPES.has(type),
      );
      expect(nonHighSignal.length).toBeGreaterThan(0);
      for (const type of nonHighSignal) {
        expect(isToastEligible(type, 'mentions')).toBe(false);
      }
    });

    it('still excludes the always-off types', () => {
      expect(isToastEligible('EMAIL_VERIFICATION_REQUIRED', 'mentions')).toBe(false);
      expect(isToastEligible('TOS_PRIVACY_UPDATED', 'mentions')).toBe(false);
    });
  });
});
