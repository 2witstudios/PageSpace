import { isV3AuthEnabled } from './v3-auth-enabled';

/**
 * Where a signed-in user lands after a signed-out or edge auth flow (email verified,
 * passkey setup). Imago users go to the v3 home; classic users keep /dashboard.
 */
export function authHomePath(): string {
  return isV3AuthEnabled() ? '/imago' : '/dashboard';
}
