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
 * `resolvedRoot`. Containment is checked via `path.relative`, not a
 * string-prefix test — a prefix check needs a trailing separator to stop
 * `/root-evil` passing as contained under `/root`, but that same trailing
 * separator makes `resolvedRoot === '/'` (the OS root) reject every legal
 * path, since `path.resolve('/', 'abc')` is `/abc`, which never starts with
 * the doubled `//` a naive `resolvedRoot + path.sep` prefix would require.
 * `path.relative` sidesteps both: contained iff the relative path is empty,
 * or doesn't escape upward (`..`) or land on an absolute path (Windows
 * drive-letter case). Checking for an EXACT `..` segment or a `..` + sep
 * prefix — not a bare `startsWith('..')` — also avoids rejecting a
 * legitimately named sibling that merely starts with two dots, e.g. `..foo`.
 *
 * `resolvedRoot` itself is trusted (an operator-configured env var, never
 * request input) — this only bounds the SEGMENTS joined onto it.
 */
export function safeBuildPath(resolvedRoot: string, ...segments: string[]): string {
  const joined = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, joined);
  const escapesRoot = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
  if (escapesRoot) {
    throw new Error(`Path escapes the build root: ${segments.join('/')}`);
  }
  return joined;
}
