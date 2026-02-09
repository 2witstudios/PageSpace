# Desktop MCP Trust Model

## Overview

PageSpace Desktop's MCP (Model Context Protocol) integration uses a **trust-based security model**, consistent with the approach taken by Claude Desktop, Cursor, and other desktop MCP clients. This is an intentional departure from the [zero-trust architecture](./zero-trust-architecture.md) used by the cloud/web deployment.

MCP servers are user-configured local processes that run on the same machine as the desktop application. The user explicitly enables each server and is responsible for vetting the software they choose to run. PageSpace does not sandbox, restrict, or intercept MCP server commands.

---

## Why Trust-Based

The trust-based model is appropriate for desktop MCP because of three properties that distinguish it from the cloud environment:

1. **Local execution context** -- MCP servers run as child processes on the user's own machine. They already operate within the user's OS-level security boundary. Restricting what a local process can do would require OS-level sandboxing (e.g., macOS App Sandbox, containers) that would break compatibility with the MCP ecosystem.

2. **Same trust boundary as the desktop app** -- The Electron main process spawns MCP servers with the same user privileges it already holds. An MCP server cannot escalate beyond the permissions the desktop app itself has. There is no privilege boundary to enforce.

3. **Explicit user opt-in** -- Users must manually configure each MCP server by specifying the command, arguments, and environment variables in the settings UI or `~/.pagespace/local-mcp-config.json`. No MCP server runs without deliberate user action.

---

## Security Boundaries

### What MCP servers CAN do

- Execute any command the user specifies (e.g., `npx`, local scripts, binaries)
- Read and write files accessible to the user's OS account
- Make network requests (no outbound restrictions)
- Access environment variables passed via configuration
- Interact with PageSpace AI chat through tool calling (when AI integration is enabled)

### What MCP servers CANNOT do

- Access the Electron main process internals or IPC channels directly -- communication is limited to the JSON-RPC 2.0 protocol over stdio (`stdin`/`stdout`)
- Modify PageSpace configuration outside of their own tool responses -- the MCP manager controls config read/write
- Access other MCP servers' processes -- each server is an isolated child process
- Bypass the MCP protocol -- the `MCPManager` class (`apps/desktop/src/main/mcp-manager.ts`) validates JSON-RPC message format and enforces timeouts

### Defensive measures in the MCP Manager

Even within the trust model, the MCP manager implements several safeguards:

| Measure | Description | Reference |
|---------|-------------|-----------|
| **stdout buffer limit** | Caps buffer at 1 MB to prevent memory exhaustion from malformed output | `MAX_STDOUT_BUFFER_SIZE_BYTES` |
| **JSON-RPC request timeout** | 30-second default timeout on all requests; configurable per-server (1 s -- 5 min) | `JSONRPC_REQUEST_TIMEOUT_MS`, `getEffectiveTimeout()` |
| **Graceful shutdown** | SIGTERM with 5-second grace period before SIGKILL | `GRACEFUL_SHUTDOWN_TIMEOUT_MS` |
| **Crash tracking** | Crash count and timestamp recorded per server | `MCPServerProcess.crashCount` |
| **Log rotation** | Server logs capped at 10 MB with 5-file rotation | `MAX_LOG_FILE_SIZE_BYTES`, `MAX_LOG_FILES` |
| **Config validation** | Server names and configuration validated via Zod schema before save | `validateMCPConfig()` |
| **Tool name validation** | Tool and server names restricted to `/^[a-zA-Z0-9_-]+$/`, max 64 characters | `MCPTool` type definition |
| **Rate-limited log I/O** | Log writes batched (100-line buffer, 1-second flush interval) to prevent I/O storms | `logServerOutput()` |

---

## Comparison with Cloud Zero-Trust

| Aspect | Cloud / Web App | Desktop MCP |
|--------|----------------|-------------|
| **Trust model** | Zero-trust: never trust, always verify | Trust-based: user-vetted local processes |
| **Authentication** | Opaque tokens validated against centralized session store | None -- local process, no auth required |
| **Authorization** | Scoped tokens with resource binding, RBAC at data layer | User's OS-level permissions |
| **Token architecture** | Hashed opaque tokens (`ps_sess_*`, `ps_svc_*`) | N/A |
| **Network boundary** | Services verify each other on every request | Single machine, no network boundary |
| **Threat model** | Untrusted network, compromised services, stolen credentials | Malicious MCP server package, supply chain attack |
| **Sandboxing** | Process isolation, scope restrictions, resource binding | None -- runs with user privileges |
| **Audit logging** | Hash-chained security audit log | File-based server output logging |

The cloud zero-trust model assumes that any service could be compromised and enforces verification at every layer. The desktop trust model assumes that the user controls what runs on their machine and accepts responsibility for the MCP servers they enable.

---

## User Responsibility and Risk Assessment

### User responsibilities

- **Vet MCP server packages** before installing. Use servers from known, reputable sources (e.g., the official `@modelcontextprotocol/*` packages).
- **Review environment variables** passed to servers. API tokens and credentials in the `env` field are visible in the config file and passed to the server process.
- **Monitor server behavior** through the settings UI status indicators and log files at `~/.pagespace/logs/mcp-*.log`.
- **Keep servers updated** to receive security patches from upstream maintainers.

### Risk assessment

| Risk | Severity | Likelihood | Mitigation |
|------|----------|------------|------------|
| Malicious MCP server package | HIGH | LOW | Only use well-known, audited packages; review source code |
| Supply chain compromise of legitimate package | HIGH | LOW | Pin versions; monitor advisories; review changelogs before updating |
| Credential leakage via env vars | MEDIUM | MEDIUM | Use scoped tokens with minimal permissions; rotate regularly |
| Server process consuming excessive resources | LOW | MEDIUM | Monitor via Activity Monitor / task manager; stop server from UI |
| Server crash loop | LOW | MEDIUM | Crash count displayed in UI; auto-start can be disabled per server |

### UI security warnings

The settings UI displays a prominent warning:

> "MCP servers execute commands on your computer. Only use servers from trusted sources."

This warning appears on the Local MCP Servers settings page and cannot be dismissed permanently.

---

## Related Documentation

- [Zero-Trust Security Architecture](./zero-trust-architecture.md) -- Cloud deployment security model
- [Local MCP Servers](../features/local-mcp-servers.md) -- Feature implementation details and configuration guide
- [MCP Manager source](../../apps/desktop/src/main/mcp-manager.ts) -- Implementation of the trust model
- [MCP Types](../../apps/desktop/src/shared/mcp-types.ts) -- Type definitions, constants, and validation
