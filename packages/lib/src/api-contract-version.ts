/**
 * The server's API contract version (ADR 0001 D1, docs/adr/0001-sdk-api-versioning.md).
 * Versions the operation registry contract — not the app, not the deploy
 * artifact. Hand-maintained; bumped only by PRs that change the contract.
 * Never derive this from npm_package_version, git tags, or image tags.
 */
export const API_CONTRACT_VERSION = '1.0.0';
