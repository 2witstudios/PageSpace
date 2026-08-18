import { resolveAppIdentity, type AppIdentity } from '../shared/app-identity';

/**
 * The identity of THIS build — the single place where the build-time variant is
 * selected.
 *
 * electron-vite substitutes `__APP_VARIANT__` textually (see
 * `electron.vite.config.ts`), so in a packaged or dev-served bundle the constant
 * is already resolved. The `typeof` guard is load-bearing: under vitest and
 * plain `tsc` the symbol does not exist at all, and the `process.env` fallback
 * takes over — which is what lets every module below be unit-tested without
 * mirroring the `define` into the test config.
 *
 * An absent or unrecognized variant resolves to PageSpace, so nothing here can
 * produce a half-configured app.
 */
const variant: string | undefined =
  typeof __APP_VARIANT__ !== 'undefined' ? __APP_VARIANT__ : process.env.PAGESPACE_APP_VARIANT;

export const APP_IDENTITY: AppIdentity = resolveAppIdentity(variant);
