import path from 'node:path';

/**
 * safeBuildPath — the ONE path-construction seam for everything under
 * `APP_BUILD_SOURCE_ROOT`. Every join of untrusted (or merely
 * server-derived-but-worth-double-checking) segments onto the build root
 * must go through this function, never a bare `path.join`/`path.resolve` —
 * that repeated pattern is exactly what CodeQL's `js/path-injection` flags
 * six separate times across `app-build.ts`/`app-build-size.ts`, once per call
 * site that constructed a path by hand.
 *
 * Mirrors the discipline `build-source-retention.ts` already applied at its
 * own single call site: resolve, then assert the result is still inside
 * `resolvedRoot` (a trailing `path.sep` in the prefix check, so
 * `/root-evil` can never pass as a prefix of `/root`).
 *
 * `resolvedRoot` itself is trusted (an operator-configured env var, never
 * request input) — this only bounds the SEGMENTS joined onto it.
 */
export function safeBuildPath(resolvedRoot: string, ...segments: string[]): string {
  const joined = path.resolve(resolvedRoot, ...segments);
  if (joined !== resolvedRoot && !joined.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes the build root: ${segments.join('/')}`);
  }
  return joined;
}
