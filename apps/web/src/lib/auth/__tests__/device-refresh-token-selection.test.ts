import { describe, it, expect } from 'vitest';
import type { DeviceRotationResult } from '@pagespace/db/transactions/auth-transactions';
import { selectDeviceTokenForResponse } from '../device-refresh-token-selection';

const CURRENT_TOKEN = 'ps_dev_current';
const CURRENT_ID = 'dt_current';

describe('selectDeviceTokenForResponse', () => {
  it('returns the newly rotated token and adopts its record id', () => {
    const rotation: DeviceRotationResult = {
      success: true,
      newToken: 'ps_dev_rotated',
      deviceTokenId: 'dt_rotated',
    };

    expect(selectDeviceTokenForResponse(CURRENT_TOKEN, CURRENT_ID, rotation)).toEqual({
      deviceToken: 'ps_dev_rotated',
      activeDeviceTokenId: 'dt_rotated',
    });
  });

  it('returns NO device token on a grace-period retry, but adopts the replacement record id', () => {
    // Rotation raced: this request lost, so it has no fresh token. Returning the
    // old (now-revoked) token here is the clobber bug — the client would persist
    // it and 401 on the next cycle. We must return no token instead.
    const rotation: DeviceRotationResult = {
      success: true,
      gracePeriodRetry: true,
      deviceTokenId: 'dt_replacement',
    };

    expect(selectDeviceTokenForResponse(CURRENT_TOKEN, CURRENT_ID, rotation)).toEqual({
      deviceToken: undefined,
      activeDeviceTokenId: 'dt_replacement',
    });
  });

  it('on a grace-period retry with no replacement id, falls back to the current record id and still returns no token', () => {
    const rotation: DeviceRotationResult = {
      success: true,
      gracePeriodRetry: true,
    };

    expect(selectDeviceTokenForResponse(CURRENT_TOKEN, CURRENT_ID, rotation)).toEqual({
      deviceToken: undefined,
      activeDeviceTokenId: CURRENT_ID,
    });
  });

  it('returns the current token unchanged when no rotation occurred (token not near expiry)', () => {
    expect(selectDeviceTokenForResponse(CURRENT_TOKEN, CURRENT_ID, null)).toEqual({
      deviceToken: CURRENT_TOKEN,
      activeDeviceTokenId: CURRENT_ID,
    });
  });
});
