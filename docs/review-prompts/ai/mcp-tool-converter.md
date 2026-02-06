# Review Vector: MCP Tool Converter

## Standards
- review.mdc
- javascript.mdc
- please.mdc

## Scope
**Files**: `apps/web/src/lib/mcp/**`, `apps/web/src/app/api/mcp/**`, `apps/web/src/app/api/mcp-ws/**`
**Level**: service

## Context
The MCP integration converts external Model Context Protocol tool definitions into Vercel AI SDK compatible tool schemas, and routes tool call results back through the MCP protocol. This includes WebSocket-based MCP server connections, token authentication, and bidirectional message translation. Format mismatches between MCP and the AI SDK silently break tool availability, so schema fidelity is paramount.
