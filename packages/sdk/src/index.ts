export * from './errors.js';

/** @pagespace/sdk npm package version. */
export const SDK_VERSION = '0.1.0';

/**
 * Reserved per ADR 0001 D3 (docs/adr/0001-sdk-api-versioning.md): the SDK's
 * compiled-in floor for the server's API_CONTRACT_VERSION. Not yet enforced —
 * see README for the deferred cross-check.
 */
export const MIN_SERVER_API_VERSION = '1.0.0';
