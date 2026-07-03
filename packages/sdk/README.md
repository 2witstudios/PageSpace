# @pagespace/sdk

The one true typed client for PageSpace. SDK resource methods, `pagespace` CLI verbs, and the
`pagespace mcp` adapter all derive from a single **operation registry** (`{ name, method, path,
inputSchema, outputSchema }`), so tool drift across surfaces is structurally impossible.

The core is **pure**: request-building and response-parsing are side-effect-free functions;
`fetch`, the clock, and randomness are constructor-injected at the edges, never reached for
directly, so unit tests never touch the network.

**Zero trust end-to-end**: every server response is zod-validated against its output schema, and
no code path in this package may ever log token material.

`MIN_SERVER_API_VERSION` (reserved here per [ADR 0001](../../docs/adr/0001-sdk-api-versioning.md)
D3) is a placeholder until the transport lands — the repo-level assertion
`MIN_SERVER_API_VERSION <= API_CONTRACT_VERSION` is deferred until
`packages/lib/src/api-contract-version.ts` exists (a later Phase 2 task).

See PageSpace page `ea07mt5jvw0flihsbjce1iv9` (epic architecture + non-negotiables) and
`docs/adr/` for the binding decisions this package follows.
