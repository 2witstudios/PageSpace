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
 *
 * 1.2.0 — `POST /api/mcp/sheets` gains two operations, `read-formatting` and
 * `apply-format`, which expose a sheet's presentation (regions, conditional
 * rules, frozen panes, column and cell formats) to SDK, CLI and MCP callers.
 * ADR 0001 D5 lists "adding an operation" as MINOR, so `MIN_SERVER_API_VERSION`
 * stays at 1.0.0 for the same reason 1.1.0 did: a client built against 1.2.0
 * still works against an older server for every other operation, it simply
 * cannot format a sheet there.
 */
export const API_CONTRACT_VERSION = '1.2.0';
