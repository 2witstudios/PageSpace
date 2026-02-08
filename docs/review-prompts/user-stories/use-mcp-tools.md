# Review Vector: Use MCP Tools

## Standards
- review.mdc (always)
- javascript.mdc (always)
- please.mdc (always)
- requirements.mdc
- productmanager.mdc

## Scope
**Files**: `apps/web/src/app/api/auth/mcp-tokens/route.ts`, `apps/web/src/app/api/auth/mcp-tokens/[tokenId]/route.ts`, `apps/web/src/app/api/mcp/documents/route.ts`, `apps/web/src/app/api/mcp/drives/route.ts`, `apps/web/src/lib/mcp/mcp-bridge.ts`, `apps/web/src/lib/ai/core/mcp-tool-converter.ts`, `apps/web/src/lib/ai/shared/hooks/useMCPTools.ts`, `apps/web/src/hooks/useMCP.ts`, `apps/web/src/stores/useMCPStore.ts`, `packages/lib/src/auth/opaque-tokens.ts`
**Level**: domain

## Context
The MCP tools journey starts when a user generates an MCP token via the token management API, which creates an opaque token with scoped permissions. An external tool connects using this token to access PageSpace documents and drives through the MCP API endpoints. The mcp-bridge handles WebSocket communication, while the mcp-tool-converter transforms MCP tool definitions into AI SDK compatible format for use in chat. This flow spans token generation with opaque token security, MCP protocol API routes, the WebSocket bridge layer, tool format conversion, and frontend MCP state management via the Zustand store and hooks.
