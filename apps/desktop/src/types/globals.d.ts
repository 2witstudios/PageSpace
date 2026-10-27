/**
 * Build-time globals injected by electron-vite's `define`.
 *
 * `__APP_VARIANT__` selects which app this bundle is (see
 * `src/shared/app-identity.ts`). It exists only in a bundle produced by
 * electron-vite; under vitest and `tsc --noEmit` the symbol is absent, which is
 * why every read of it is guarded by `typeof __APP_VARIANT__ !== 'undefined'`.
 */
declare const __APP_VARIANT__: string | undefined;
