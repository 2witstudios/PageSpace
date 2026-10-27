import { describe, it, expect } from 'vitest';

import {
  PENDING_UPLOAD_TTL_MS,
  pendingUploadExpiresAt,
  isPendingUploadLive,
  countLivePendingUploads,
  canStartUpload,
} from '../pending-uploads-core';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');

describe('pending-uploads-core', () => {
  describe('PENDING_UPLOAD_TTL_MS', () => {
    it('ttl_matchesSemaphoreSlotTimeout_tenMinutes', () => {
      expect(PENDING_UPLOAD_TTL_MS).toBe(10 * 60 * 1000);
    });
  });

  describe('pendingUploadExpiresAt', () => {
    it('pendingUploadExpiresAt_withDefaultTtl_returnsNowPlusTtl', () => {
      expect(pendingUploadExpiresAt(NOW).getTime()).toBe(NOW + PENDING_UPLOAD_TTL_MS);
    });

    it('pendingUploadExpiresAt_withExplicitTtl_returnsNowPlusTtl', () => {
      expect(pendingUploadExpiresAt(NOW, 1000).getTime()).toBe(NOW + 1000);
    });

    it('pendingUploadExpiresAt_withNonPositiveTtl_fallsBackToDefaultTtl', () => {
      expect(pendingUploadExpiresAt(NOW, 0).getTime()).toBe(NOW + PENDING_UPLOAD_TTL_MS);
      expect(pendingUploadExpiresAt(NOW, -5).getTime()).toBe(NOW + PENDING_UPLOAD_TTL_MS);
    });

    it('pendingUploadExpiresAt_withNonFiniteTtl_fallsBackToDefaultTtl', () => {
      expect(pendingUploadExpiresAt(NOW, Number.NaN).getTime()).toBe(NOW + PENDING_UPLOAD_TTL_MS);
      expect(pendingUploadExpiresAt(NOW, Number.POSITIVE_INFINITY).getTime()).toBe(NOW + PENDING_UPLOAD_TTL_MS);
    });
  });

  describe('isPendingUploadLive', () => {
    it('isPendingUploadLive_withFutureExpiry_returnsTrue', () => {
      expect(isPendingUploadLive({ expiresAt: new Date(NOW + 1) }, NOW)).toBe(true);
    });

    it('isPendingUploadLive_withExpiryExactlyNow_returnsFalse', () => {
      expect(isPendingUploadLive({ expiresAt: new Date(NOW) }, NOW)).toBe(false);
    });

    it('isPendingUploadLive_withPastExpiry_returnsFalse', () => {
      expect(isPendingUploadLive({ expiresAt: new Date(NOW - 1) }, NOW)).toBe(false);
    });
  });

  describe('countLivePendingUploads', () => {
    it('countLivePendingUploads_withEmptyList_returnsZero', () => {
      expect(countLivePendingUploads([], NOW)).toBe(0);
    });

    it('countLivePendingUploads_withMixedRows_countsOnlyUnexpired', () => {
      const rows = [
        { expiresAt: new Date(NOW + 1000) },
        { expiresAt: new Date(NOW - 1000) },
        { expiresAt: new Date(NOW + 1) },
        { expiresAt: new Date(NOW) },
      ];
      expect(countLivePendingUploads(rows, NOW)).toBe(2);
    });
  });

  describe('canStartUpload', () => {
    it('canStartUpload_underLimit_returnsTrue', () => {
      expect(canStartUpload(2, 3)).toBe(true);
    });

    it('canStartUpload_atLimit_returnsFalse', () => {
      expect(canStartUpload(3, 3)).toBe(false);
    });

    it('canStartUpload_overLimit_returnsFalse', () => {
      expect(canStartUpload(4, 3)).toBe(false);
    });

    it('canStartUpload_withZeroOrNegativeLimit_returnsFalse', () => {
      expect(canStartUpload(0, 0)).toBe(false);
      expect(canStartUpload(0, -1)).toBe(false);
    });

    it('canStartUpload_withNonFiniteInputs_returnsFalse', () => {
      expect(canStartUpload(Number.NaN, 3)).toBe(false);
      expect(canStartUpload(0, Number.NaN)).toBe(false);
    });
  });
});
