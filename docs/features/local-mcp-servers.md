# Local MCP Servers - Desktop Feature Implementation

## Overview

Local MCP Servers is PageSpace Desktop's first desktop-only feature, allowing users to run Model Context Protocol servers on their local machine, similar to Claude Desktop, Cursor, and Roo Code.

**Status**: Phase 1 Complete (Infrastructure & UI) ✅
**Next**: Phase 2 (AI Integration) 📋

---

## Phase 1: Infrastructure & UI (COMPLETED)

### What's Been Implemented

#### 1. Core Infrastructure ✅

**MCP Manager** (`apps/desktop/src/main/mcp-manager.ts`)
- Spawns and manages MCP server child processes via Node.js `child_process`
- Supports `npx -y` command pattern (standard across Claude Desktop, etc.)
- Process lifecycle management: start, stop, restart
- Auto-start on app launch (configurable per-server)
- Health monitoring and crash detection
- Graceful shutdown on app quit
- Logging to `~/.pagespace/logs/` directory

**Configuration Management**
- File-based config at `~/.pagespace/local-mcp-config.json`
- Local-only (no cloud sync)
- Compatible with Claude Desktop JSON format
- Environment variable support per-server

**IPC Bridge** (`apps/desktop/src/main/index.ts` + `apps/desktop/src/preload/index.ts`)
- Secure communication between main process and renderer
- Exposed methods:
  - `window.electron.mcp.getConfig()`
  - `window.electron.mcp.updateConfig(config)`
  - `window.electron.mcp.startServer(name)`
  - `window.electron.mcp.stopServer(name)`
  - `window.electron.mcp.restartServer(name)`
  - `window.electron.mcp.getServerStatuses()`
- Desktop detection flag: `window.electron.isDesktop`

#### 2. User Interface ✅

**Settings Integration** (`apps/web/src/app/settings/page.tsx`)
- "Local MCP Servers" card in main settings (desktop-only)
- Filtered out on web version automatically
- Clear distinction from "MCP Connection" (cloud feature)

**Local MCP Settings Page** (`apps/web/src/app/settings/local-mcp/page.tsx`)
- **Three-tab interface**:
  1. **Servers Tab**: Visual server management
  2. **Configuration Tab**: Raw JSON editor
  3. **Getting Started Tab**: Documentation and examples

**Features**:
- Real-time server status indicators (running/stopped/error/crashed)
- Start/stop/restart controls per server
- Add/remove servers via dialog
- JSON configuration editor with validation
- Server status cards showing:
  - Status badge (running, stopped, error, crashed)
  - Command and arguments
  - Crash count
  - Auto-start and enabled flags
  - Error messages
- Auto-refresh every 3 seconds
- Desktop-only detection with informative message for web users

#### 3. Security & Documentation ✅

**Security Warnings**
- Prominent alert in settings UI:
  > "MCP servers execute commands on your computer. Only use servers from trusted sources."
- Trust-based security model (matches Claude Desktop)
- No hard restrictions on commands (user responsibility)

**Getting Started Guide**
- What are MCP Servers
- Popular MCP servers with example commands:
  - Filesystem: `npx -y @modelcontextprotocol/server-filesystem /path`
  - GitHub: `npx -y @modelcontextprotocol/server-github`
  - Slack: `npx -y @modelcontextprotocol/server-slack`
- Configuration format explanation
- Environment variable examples
- Fully compatible with Claude Desktop configs

#### 4. Error Handling ✅

- Toast notifications for all operations (success/failure)
- Server crash detection and tracking
- Detailed error logging to files
- Graceful degradation when servers fail
- JSON validation with user-friendly error messages

---

## Phase 2: AI Integration (NEXT)

### Architecture Challenge

The main architectural challenge is that:
1. **MCP servers run in Electron main process** (Node.js)
2. **AI chat runs in Next.js API routes** (separate Node.js process in renderer's web context)
3. **AI SDK MCP client expects to spawn its own processes**

This creates a mismatch - we're already spawning MCP processes, but the AI SDK wants to spawn them itself.

### Implementation Options

#### Option A: Implement MCP Protocol Directly ⭐ (Recommended)

**Approach**: Manually implement MCP JSON-RPC protocol communication

**Steps**:
1. **Tool Discovery**:
   - Send MCP `tools/list` request via stdio to running servers
   - Parse JSON-RPC responses
   - Convert tool schemas to AI SDK format

2. **Tool Execution**:
   - Proxy tool calls from AI chat through IPC
   - Send MCP `tools/call` requests to appropriate server
   - Return results to AI SDK

3. **Integration Points**:
   - Add `window.electron.mcp.getAvailableTools()` IPC method
   - Add `window.electron.mcp.executeTool(server, tool, args)` IPC method
   - Modify `/api/ai/chat/route.ts` to detect desktop and fetch tools
   - Inject MCP tools into `streamText` tool array
   - Add per-chat toggle in CHAT_AI header
   - Add global toggle in settings sidebar

**Pros**:
- Full control over protocol
- Works with existing process management
- Can optimize for performance

**Cons**:
- Need to implement MCP protocol manually
- More code to maintain

**References**:
- MCP Protocol Spec: https://spec.modelcontextprotocol.io/
- MCP JSON-RPC Messages: https://spec.modelcontextprotocol.io/protocol/

#### Option B: Refactor to Use AI SDK MCP Client

**Approach**: Let AI SDK manage MCP server processes

**Steps**:
1. Remove custom process spawning from `mcp-manager.ts`
2. Use `experimental_createMCPClient` from `ai` package
3. Let AI SDK spawn processes and manage stdio communication
4. Fetch tools directly using `client.tools()`

**Pros**:
- Leverages battle-tested AI SDK code
- Less custom protocol code

**Cons**:
- Lose fine-grained process control
- Harder to implement status monitoring
- Requires significant refactoring

#### Option C: Hybrid Approach

**Approach**: Keep process management separate from AI integration

**Steps**:
1. Keep current process spawning for status/monitoring
2. For AI chat, spawn temporary MCP clients using AI SDK
3. These clients spawn their own processes (duplicate servers running)
4. Clean up after chat request completes

**Pros**:
- Minimal refactoring
- Clean separation of concerns

**Cons**:
- Duplicate processes running
- Higher resource usage
- Complexity in managing two process sets

---

## Phase 2 Implementation Checklist

### 1. MCP Protocol Implementation
- [ ] Implement `tools/list` JSON-RPC request/response
- [ ] Implement `tools/call` JSON-RPC request/response
- [ ] Add stdio message queuing and response matching
- [ ] Handle protocol errors gracefully
- [ ] Add timeout handling for tool calls

### 2. Tool Discovery & Management
- [ ] Create `getMCPTools()` method in mcp-manager
- [ ] Parse tool schemas from MCP responses
- [ ] Convert to AI SDK tool format
- [ ] Cache tool definitions (refresh on server restart)
- [ ] Add IPC handler: `mcp:get-available-tools`

### 3. Tool Execution Proxy
- [ ] Create tool execution wrapper in mcp-manager
- [ ] Add IPC handler: `mcp:execute-tool`
- [ ] Handle async tool execution
- [ ] Stream tool results if needed
- [ ] Add error handling and retries

### 4. AI Chat Integration
- [ ] Modify `/api/ai/chat/route.ts` to detect desktop mode
- [ ] Add desktop header/flag detection
- [ ] Fetch MCP tools via special endpoint or mechanism
- [ ] Inject MCP tools into `streamText` tools array
- [ ] Handle tool execution callbacks
- [ ] Add MCP tool usage tracking

### 5. UI Toggles
- [ ] Add global "Enable Local MCP" toggle to settings sidebar
- [ ] Store toggle state in Zustand or localStorage
- [ ] Add per-chat "Use Local MCP" toggle in CHAT_AI header
- [ ] Show indicator when MCP tools are active
- [ ] Display which MCP servers are being used

### 6. Testing & Polish
- [ ] Test with filesystem MCP server
- [ ] Test with multiple servers simultaneously
- [ ] Test tool execution error handling
- [ ] Test process crash recovery
- [ ] Add tool execution timeout (30s default)
- [ ] Add rate limiting for tool calls
- [ ] Performance testing with many tools

---

## Configuration Examples

### Filesystem Server
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Documents"],
      "autoStart": true,
      "enabled": true
    }
  }
}
```

### Multiple Servers with Environment Variables
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Documents"],
      "autoStart": true,
      "enabled": true
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      },
      "autoStart": false,
      "enabled": true
    }
  }
}
```

---

## File Structure

```
apps/desktop/
├── src/
│   ├── main/
│   │   ├── index.ts              # Main entry, MCP IPC handlers
│   │   ├── mcp-manager.ts        # Process lifecycle management ✅
│   │   └── mcp-bridge.ts         # MCP protocol communication (stub)
│   └── preload/
│       └── index.ts              # IPC exposure to renderer ✅

apps/web/
└── src/
    ├── app/
    │   ├── settings/
    │   │   ├── page.tsx          # Settings landing (w/ desktop detection) ✅
    │   │   └── local-mcp/
    │   │       └── page.tsx      # Local MCP settings UI ✅
    │   └── api/
    │       └── ai/
    │           └── chat/
    │               └── route.ts  # AI chat (needs MCP integration)
    └── components/
        └── ai/
            └── ChatAI.tsx        # Chat UI (needs MCP toggle)
```

---

## Technical Notes

### Process Management
- MCP servers are spawned with `stdio: ['pipe', 'pipe', 'pipe']`
- stdin/stdout used for MCP JSON-RPC protocol
- stderr captured for logging
- Graceful shutdown with SIGTERM (5s timeout, then SIGKILL)

### Configuration Storage
- Location: `~/.pagespace/local-mcp-config.json`
- Created on first launch if missing
- Never synced to cloud (local-only feature)
- Compatible with Claude Desktop format

### Logging
- Server output: `~/.pagespace/logs/mcp-{serverName}.log`
- Errors: `~/.pagespace/logs/mcp-errors.log`
- Includes timestamps and server names

### Status Polling
- Settings UI polls status every 3 seconds
- Efficient - only fetches status, not full config
- Updates UI badges and controls in real-time

---

## Future Enhancements

### Short Term
- Tool execution with streaming results
- Tool usage analytics (which tools are used most)
- Server installation wizard (suggest popular servers)
- Import Claude Desktop config with one click

### Medium Term
- MCP server marketplace/directory
- Built-in popular servers (bundled with app)
- Server templates for common use cases
- Tool preview/testing UI

### Long Term
- MCP server development tools
- Custom tool creation wizard
- Server debugging tools
- Performance monitoring dashboard

---

## Testing Strategy

### Unit Tests
- MCP manager process lifecycle
- Configuration loading/saving
- IPC handlers
- Tool schema conversion

### Integration Tests
- Full server start/stop cycle
- Configuration updates
- Tool discovery
- Tool execution

### E2E Tests
- Desktop app with MCP servers
- Settings UI interactions
- AI chat with MCP tools
- Error scenarios

---

## Success Metrics

### Phase 1 (Current) ✅
- [x] Users can configure MCP servers via UI
- [x] Users can start/stop servers manually
- [x] Servers auto-start on app launch
- [x] Status monitoring works in real-time
- [x] Claude Desktop configs work without modification

### Phase 2 (Next)
- [ ] MCP tools appear in AI chat
- [ ] Tools execute correctly
- [ ] Tool results integrate with AI responses
- [ ] Performance: <100ms overhead per tool call
- [ ] Reliability: 99% tool execution success rate

---

## Questions & Decisions

### Resolved ✅
1. **Config format**: Use Claude Desktop format (industry standard)
2. **Config location**: `~/.pagespace/local-mcp-config.json` (local-only)
3. **Security model**: Trust-based with warnings (matches Claude Desktop)
4. **UI approach**: Three-tab interface (servers/config/guide)

### Pending 🔄
1. **MCP protocol implementation**: Option A (manual) vs Option B (AI SDK)?
2. **Tool caching**: Cache tool definitions or fetch on every chat?
3. **Rate limiting**: Should we limit tool calls per minute?
4. **Tool namespacing**: Prefix with `mcp_` or show server in UI?

---

## Troubleshooting Guide

### Server Won't Start

**Symptom**: Server status shows "error" immediately after clicking start

**Possible Causes**:
1. **Invalid command or arguments**
   - Check that the command is correct (usually `npx`)
   - Verify arguments are properly formatted
   - Example: `npx -y @modelcontextprotocol/server-filesystem /path/to/directory`

2. **Missing dependencies**
   - Ensure `npx` is installed (`npm install -g npx`)
   - Check that the MCP server package exists

3. **Permission issues**
   - Verify directory paths are accessible
   - Check file system permissions

**Solution**:
- View logs at `~/.pagespace/logs/mcp-{servername}.log`
- Check error log at `~/.pagespace/logs/mcp-errors.log`
- Verify the command works in terminal first

### Server Crashes Repeatedly

**Symptom**: Status shows "crashed" or cycles between "starting" and "crashed"

**Possible Causes**:
1. **Invalid configuration**
   - Environment variables missing or incorrect
   - Required paths don't exist

2. **Port conflicts**
   - Another process using the same port
   - Multiple instances of same server

**Solution**:
- Check crash count in server card
- Review error logs for specific error messages
- Ensure only one instance of server is configured
- Verify all required environment variables are set

### Tools Not Appearing in AI Chat

**Symptom**: MCP server is running but tools don't show up in chat

**Status**: Phase 2 feature (not yet implemented)

**Expected Behavior (Phase 2)**:
- Running servers will automatically expose tools to AI
- Tools will be prefixed with `mcp_{servername}_`
- Enable per-chat with toggle in chat header

### Configuration Won't Save

**Symptom**: Clicking "Save Configuration" shows an error

**Possible Causes**:
1. **Invalid JSON format**
   - Missing commas, brackets, or quotes
   - Invalid server name format

2. **Validation errors**
   - Server names must only contain letters, numbers, hyphens, underscores
   - Command must be non-empty
   - Args must be an array

**Solution**:
- Use JSON validator (Configuration tab shows specific error)
- Check server name format: `^[a-zA-Z0-9_-]+$`
- Verify structure matches examples in Getting Started

### Viewing Logs

**Log Locations**:
- Server output: `~/.pagespace/logs/mcp-{servername}.log`
- Server errors: `~/.pagespace/logs/mcp-errors.log`
- Log files auto-rotate at 10MB (keeps last 5 files)

**How to Access**:
```bash
# View server log
tail -f ~/.pagespace/logs/mcp-filesystem.log

# View error log
tail -f ~/.pagespace/logs/mcp-errors.log

# View all MCP logs
ls -lh ~/.pagespace/logs/mcp-*.log
```

### Server Status Stuck on "Starting"

**Symptom**: Server shows "starting" status for more than a few seconds

**Possible Causes**:
1. **Server taking too long to initialize**
2. **Process spawned but immediately exits**

**Solution**:
- Wait 5-10 seconds (some servers are slow to start)
- If still stuck, click stop then restart
- Check logs for initialization errors

### Desktop App Not Recognizing MCP Feature

**Symptom**: "Local MCP Servers" not showing in settings

**Possible Causes**:
1. **Not running desktop app** (using web version)
2. **Old desktop app version**

**Solution**:
- Verify you're running PageSpace Desktop (not web)
- Check desktop app version in menu
- Update to latest desktop app version

### Environment Variables Not Working

**Symptom**: Server starts but fails to authenticate with API

**Possible Causes**:
1. **Environment variables not properly set in config**
2. **Token/key format incorrect**

**Solution**:
```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_actual_token_here"
      }
    }
  }
}
```

### Common Error Messages

| Error | Meaning | Solution |
|-------|---------|----------|
| "Process exited immediately after start" | Server crashed on startup | Check server logs and verify configuration |
| "Invalid configuration: mcpServers..." | Zod validation failed | Fix server name or configuration structure |
| "Failed to start server: spawn ENOENT" | Command not found | Install the command (e.g., `npm install -g npx`) |
| "Failed to start server: EACCES" | Permission denied | Check file/directory permissions |

### Getting Help

If issues persist:

1. **Check logs** at `~/.pagespace/logs/`
2. **Test command in terminal** to verify it works standalone
3. **Review configuration** against examples in Getting Started
4. **Report issue** at https://github.com/2witstudios/pagespace/issues with:
   - Server configuration (redact sensitive data)
   - Error logs
   - Steps to reproduce

---

## References

- [Model Context Protocol Spec](https://spec.modelcontextprotocol.io/)
- [AI SDK MCP Documentation](https://ai-sdk.dev/cookbook/node/mcp-tools)
- [Claude Desktop MCP Guide](https://docs.claude.com/en/docs/claude-code/mcp)
- [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
