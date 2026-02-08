# Review Vector: MCP Routes

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- stack.mdc

## Scope
**Files**: `apps/web/src/app/api/mcp/**/route.ts`, `apps/web/src/app/api/mcp-ws/**/route.ts`, `apps/web/src/app/api/auth/mcp-tokens/**/route.ts`
**Level**: route

## Context
MCP routes implement the Model Context Protocol integration, allowing external AI tools (like Claude Code) to read and write PageSpace documents and list drives. The MCP-WS endpoint provides a WebSocket transport for persistent MCP connections. MCP token routes under auth manage token creation, listing, and revocation for API access without browser sessions. MCP tokens are long-lived bearer tokens with scoped permissions, so token generation must enforce proper entropy, and document operations must respect the token's permission scope rather than granting blanket access to the token owner's full account.
