/**
 * Where a given variant's compiled bundle lands.
 *
 * Build-time rather than runtime config, but it lives beside the identity
 * registry because three places have to agree on it and nothing else forces
 * them to: `electron.vite.config.ts` writes here, `dev:coder` sets
 * `ELECTRON_ENTRY` to here, and `electron-builder.coder.json` packages from
 * here. When they disagree the failure is silent — `electron-vite dev` resolves
 * its entry through package.json's single `main`, so a variant that only moved
 * `outDir` would compile the coder bundle and then run the PageSpace one.
 *
 * PageSpace keeps the bare `out` that package.json `main` names, so its dev
 * script needs no override at all.
 */
export function outRootFor(variant: string): string {
  return variant === 'pagespace' ? 'out' : `out-${variant}`;
}
