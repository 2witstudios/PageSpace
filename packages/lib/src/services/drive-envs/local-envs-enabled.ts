/**
 * Cloud opt-in for local environments (Local Environments epic, invariant 11).
 *
 * Exposing personal hardware to a shared cloud drive is never a default: the
 * create, enroll and token paths all refuse unless `LOCAL_ENVS_ENABLED` is the
 * exact string `'true'`. Read directly from the environment, like
 * `CODE_EXECUTION_ENABLED` in `can-run-code.ts`, so it works in the realtime
 * tier's lean env as well as in apps/web. Anything but `'true'` — unset, `1`,
 * `yes` — is off.
 */
export const LOCAL_ENVS_ENABLED_VAR = 'LOCAL_ENVS_ENABLED';

export function isLocalEnvsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[LOCAL_ENVS_ENABLED_VAR] === 'true';
}
