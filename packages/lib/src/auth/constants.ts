/**
 * Authentication constants shared across the application
 */

import { isOnPrem } from '../deployment-mode';

/**
 * Default session duration: 7 days in milliseconds
 * Used for web sessions and OAuth authentication flows
 */
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Marks sessions minted by the standalone admin console (apps/admin) via the
 * sessions.createdByService column. Lets login revocation be scoped per-app so
 * an admin login does not revoke web sessions, and vice versa.
 */
export const ADMIN_SESSION_SERVICE = 'admin-console';


/**
 * Idle session timeout in milliseconds.
 * HIPAA requires automatic logoff after a period of inactivity.
 * Configurable via SESSION_IDLE_TIMEOUT_MS env var (value in milliseconds).
 * Defaults to 15 minutes on-prem. Set to 0 to disable idle timeout (cloud default).
 */
export const IDLE_TIMEOUT_MS: number = (() => {
  const envVal = process.env.SESSION_IDLE_TIMEOUT_MS;
  if (envVal) {
    const parsed = Number(envVal);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.warn(`[auth] Invalid SESSION_IDLE_TIMEOUT_MS value "${envVal}", falling back to default`);
    } else {
      return parsed;
    }
  }
  return isOnPrem() ? 15 * 60 * 1000 : 0;
})();
