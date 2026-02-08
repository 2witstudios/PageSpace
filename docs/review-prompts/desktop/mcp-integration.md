# Review Vector: MCP Integration

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)

## Scope
**Files**: `apps/desktop/src/**`
**Level**: service

## Context
The desktop app embeds an MCP server that exposes PageSpace document operations to external AI tools and agents. Review that the MCP protocol implementation correctly handles tool registration, request routing, and response serialization. Verify that MCP token authentication is enforced for all operations and that the server binds only to localhost to prevent remote access.
