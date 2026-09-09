/**
 * The server's API contract version (ADR 0001 D1, docs/adr/0001-sdk-api-versioning.md).
 * Versions the operation registry contract — not the app, not the deploy
 * artifact. Hand-maintained; bumped only by PRs that change the contract.
 * Never derive this from npm_package_version, git tags, or image tags.
 *
 * 1.1.0 — `POST /api/ai/page-agents/consult` accepts `newConversationId`, a
 * caller-chosen address for a new conversation. Additive and optional, so it
 * is a MINOR bump and `MIN_SERVER_API_VERSION` deliberately stays at 1.0.0:
 * a client built against 1.1.0 still works against a 1.0.0 server for every
 * operation, it simply does not get to choose the address.
 */
export const API_CONTRACT_VERSION = '1.1.0';
