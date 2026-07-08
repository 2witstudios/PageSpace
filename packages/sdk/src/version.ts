import type { CompatibilityResult } from './errors.js';

/**
 * @pagespace/sdk npm package version. Must equal package.json's `version` —
 * guarded by `__tests__/version.test.ts`, which reads package.json directly,
 * so bumping one without the other fails the suite.
 */
export const SDK_VERSION = '1.5.1';

/**
 * The SDK's compiled-in floor for the server's API_CONTRACT_VERSION (ADR 0001
 * D3, docs/adr/0001-sdk-api-versioning.md). Enforced by the facade's lazy,
 * cached compatibility check (Phase 2 task 6) against every 2xx response's
 * `X-PageSpace-API-Version` header.
 */
export const MIN_SERVER_API_VERSION = '1.0.0';

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const STRICT_SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** Parses a strict semver "MAJOR.MINOR.PATCH" — no ranges, no prerelease/build metadata. */
export function parseApiVersion(raw: string): ParsedVersion | null {
  const match = STRICT_SEMVER.exec(raw);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Total order on parsed versions. */
export function compareApiVersions(a: ParsedVersion, b: ParsedVersion): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * The single compatibility decision (ADR 0001 D4/D6): fail closed on a
 * missing or malformed header, on a server major that differs from the
 * SDK's minimum, or on a server behind the minimum within the same major.
 */
export function checkServerCompatibility(
  serverVersion: string | null,
  sdkMinVersion: string,
): CompatibilityResult {
  if (serverVersion === null) {
    return { ok: false, reason: 'missing-header', serverVersion: null, sdkMinVersion };
  }

  const parsedServer = parseApiVersion(serverVersion);
  if (!parsedServer) {
    return { ok: false, reason: 'malformed-version', serverVersion, sdkMinVersion };
  }

  const parsedMin = parseApiVersion(sdkMinVersion);
  if (!parsedMin) {
    throw new TypeError(`sdkMinVersion "${sdkMinVersion}" is not a valid strict semver`);
  }

  if (parsedServer.major !== parsedMin.major) {
    return { ok: false, reason: 'major-mismatch', serverVersion, sdkMinVersion };
  }

  if (compareApiVersions(parsedServer, parsedMin) < 0) {
    return { ok: false, reason: 'server-too-old', serverVersion, sdkMinVersion };
  }

  return { ok: true, serverVersion };
}
