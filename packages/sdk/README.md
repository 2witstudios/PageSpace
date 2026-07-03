# @pagespace/sdk

The one true typed client for PageSpace. SDK resource methods, `pagespace` CLI verbs, and the
`pagespace mcp` adapter all derive from a single **operation registry** (`{ name, method, path,
inputSchema, outputSchema }`), so tool drift across surfaces is structurally impossible.

The core is **pure**: request-building and response-parsing are side-effect-free functions;
`fetch`, the clock, and randomness are constructor-injected at the edges, never reached for
directly, so unit tests never touch the network.

**Zero trust end-to-end**: every server response is zod-validated against its output schema, and
no code path in this package may ever log token material.

`PageSpaceClient` enforces the [ADR 0001](../../docs/adr/0001-sdk-api-versioning.md) handshake:
every 2xx response is checked, lazily and once per client instance, against the SDK's compiled-in
`MIN_SERVER_API_VERSION`, and an incompatible server fails closed with `IncompatibleServerError`
(opt out only via the explicit `skipVersionCheck: true`). The repo-level assertion
`MIN_SERVER_API_VERSION <= API_CONTRACT_VERSION` is still deferred until
`packages/lib/src/api-contract-version.ts` exists (Phase 1/7).

See PageSpace page `ea07mt5jvw0flihsbjce1iv9` (epic architecture + non-negotiables) and
`docs/adr/` for the binding decisions this package follows.
