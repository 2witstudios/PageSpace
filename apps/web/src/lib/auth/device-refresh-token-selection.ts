/**
 * Functional core for choosing which device token the refresh route returns to
 * the client, and which device-token record its activity update should target.
 *
 * The grace-clobber bug: `atomicDeviceTokenRotation` can return `success` with
 * `gracePeriodRetry: true` and NO `newToken` when this request lost a rotation
 * race (a concurrent refresh already rotated the token within the 30s grace
 * window). The route previously fell through and returned the OLD — now revoked —
 * token, which the client persisted, guaranteeing a 401 on the next refresh and a
 * full logout. The fix: on a grace-period retry, return NO device token so the
 * client keeps the good token it already holds, while still adopting the
 * replacement record id so the activity update lands on the live row.
 */

import type { DeviceRotationResult } from '@pagespace/db/transactions/auth-transactions';

export interface DeviceTokenSelection {
  /**
   * Token to send back to the client. `undefined` means "send no deviceToken" —
   * the client must keep whatever token it already has.
   */
  deviceToken: string | undefined;
  /** Device-token record id the activity update should target. */
  activeDeviceTokenId: string;
}

/**
 * Decide the response device token given the rotation outcome.
 *
 * - `rotation` is `null` when no rotation was attempted (token not near expiry):
 *   return the current token unchanged.
 * - A real rotation (`newToken` + `deviceTokenId`): return the new token and its id.
 * - A grace-period retry (`success`, no `newToken`): return NO token, adopting the
 *   replacement `deviceTokenId` (falling back to the current id if absent).
 */
export function selectDeviceTokenForResponse(
  currentDeviceToken: string,
  currentDeviceTokenId: string,
  rotation: DeviceRotationResult | null,
): DeviceTokenSelection {
  if (rotation?.newToken && rotation.deviceTokenId) {
    return { deviceToken: rotation.newToken, activeDeviceTokenId: rotation.deviceTokenId };
  }

  if (rotation?.success && rotation.gracePeriodRetry) {
    return {
      deviceToken: undefined,
      activeDeviceTokenId: rotation.deviceTokenId ?? currentDeviceTokenId,
    };
  }

  return { deviceToken: currentDeviceToken, activeDeviceTokenId: currentDeviceTokenId };
}
