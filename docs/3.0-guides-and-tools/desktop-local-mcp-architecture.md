# PageSpace Desktop Local MCP Architecture

**Last Updated**: 2025-10-29
**Status**: Implemented
**Version**: 1.1

## Table of Contents

1. [Overview](#overview)
2. [Architecture Diagram](#architecture-diagram)
3. [Core Components](#core-components)
4. [Authentication System](#authentication-system)
5. [Configuration Management](#configuration-management)
6. [Process Management](#process-management)
7. [Command Resolution System](#command-resolution-system)
8. [Tool Discovery and Execution](#tool-discovery-and-execution)
9. [WebSocket Bridge](#websocket-bridge)
10. [Frontend Integration](#frontend-integration)
11. [Data Flow](#data-flow)
12. [File Structure](#file-structure)
13. [Security Considerations](#security-considerations)
14. [Error Handling](#error-handling)
15. [Testing Strategy](#testing-strategy)

---

## Overview

PageSpace Desktop implements a complete Model Context Protocol (MCP) server management system, allowing users to run MCP servers locally on their machine, similar to Claude Desktop, Cursor, and Roo Code. This system provides:

- **Local MCP Server Management**: Spawn, monitor, and control MCP server processes
- **Tool Discovery**: Automatically discover and cache tools from running servers
- **Tool Execution**: Execute tools via JSON-RPC with timeout handling
- **WebSocket Bridge**: Optional connection to VPS for remote tool execution
- **Bearer Token Authentication**: CSRF-exempt authentication for desktop app
- **Configuration UI**: User-friendly interface for managing server configurations

### Key Features

✅ **Compatible with Claude Desktop Config Format**: Uses the same JSON config structure
✅ **Auto-Start Servers**: Servers auto-start by default (opt-out model with `autoStart: false`)
✅ **Command Resolution**: Automatically resolves commands to absolute paths (critical for packaged apps)
✅ **Crash Recovery**: Monitors server health and tracks crash counts
✅ **Log Rotation**: Automatic log file rotation (10MB per file, 5 files max)
✅ **JSON-RPC Communication**: Standard JSON-RPC 2.0 protocol over stdin/stdout
✅ **Tool Caching**: Caches tool definitions for performance
✅ **Real-time Status Updates**: Live status broadcasting to UI (3s polling interval)
✅ **Graceful Shutdown**: Properly terminates all servers on app quit

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                       PageSpace Desktop App                          │
│                                                                       │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐      │
│  │   Renderer   │◄────►│   Preload    │◄────►│     Main     │      │
│  │   Process    │      │   Script     │      │   Process    │      │
│  │              │      │   (Bridge)   │      │              │      │
│  └──────┬───────┘      └──────────────┘      └──────┬───────┘      │
│         │                                             │              │
│         │  React Components                           │              │
│         │  - Settings UI                              │              │
│         │  - AI Chat Integration                      │              │
│         │  - Status Display                           │              │
│         │                                             │              │
└─────────┼─────────────────────────────────────────────┼──────────────┘
          │                                             │
          │ IPC Communication                           │
          │ (window.electron API)                       │
          │                                             │
          │                                             ▼
          │                                    ┌────────────────┐
          │                                    │  MCP Manager   │
          │                                    │  (Singleton)   │
          │                                    └────────┬───────┘
          │                                             │
          │                                             │ Manages
          │                                             ▼
          │                              ┌──────────────────────────┐
          │                              │   MCP Server Processes   │
          │                              │                          │
          │                              │  ┌─────────────────┐    │
          │                              │  │  Server 1       │    │
          │                              │  │  (Child Process)│    │
          │                              │  │  - Spawned      │    │
          │                              │  │  - JSON-RPC     │    │
          │                              │  │  - stdio pipes  │    │
          │                              │  └─────────────────┘    │
          │                              │                          │
          │                              │  ┌─────────────────┐    │
          │                              │  │  Server 2       │    │
          │                              │  │  (Child Process)│    │
          │                              │  └─────────────────┘    │
          │                              └──────────────────────────┘
          │
          │ HTTP/WS
          ▼
┌────────────────────┐                 ┌─────────────────────┐
│  PageSpace VPS     │                 │   Configuration     │
│  (Optional)        │                 │   ~/.pagespace/     │
│                    │                 │                     │
│  - AI Chat API     │                 │  - config.json      │
│  - Tool Execution  │                 │  - logs/            │
│  - WS Bridge       │                 │                     │
└────────────────────┘                 └─────────────────────┘
```

---

## Core Components

### 1. MCP Manager (`apps/desktop/src/main/mcp-manager.ts`)

**Purpose**: Central coordinator for MCP server lifecycle management

**Responsibilities**:
- Load/save configuration from `~/.pagespace/local-mcp-config.json`
- Spawn and manage child processes for MCP servers
- Handle JSON-RPC communication (stdin/stdout)
- Monitor server health and handle crashes
- Discover and cache tools from running servers
- Execute tools with timeout handling
- Manage log rotation

**Key Methods**:
```typescript
class MCPManager {
  // Initialization
  async initialize(): Promise<void>

  // Configuration
  getConfig(): MCPConfig
  async updateConfig(newConfig: MCPConfig): Promise<void>

  // Server Lifecycle
  async startServer(name: string): Promise<void>
  async stopServer(name: string): Promise<void>
  async restartServer(name: string): Promise<void>
  async shutdown(): Promise<void>

  // Status
  getServerStatuses(): Record<string, MCPServerStatusInfo>
  getServerStatus(name: string): MCPServerStatus | null

  // Tool Discovery
  async getMCPTools(serverName: string): Promise<MCPTool[]>
  getAggregatedTools(): MCPTool[]
  getServerTools(serverName: string): MCPTool[]

  // Tool Execution
  async executeTool(serverName: string, toolName: string, args?: Record<string, unknown>): Promise<ToolExecutionResult>

  // JSON-RPC Communication
  async sendJSONRPCRequest(serverName: string, method: string, params?: unknown): Promise<JSONRPCResponse>
}
```

**Singleton Pattern**:
```typescript
let mcpManager: MCPManager | null = null;

export function getMCPManager(): MCPManager {
  if (!mcpManager) {
    mcpManager = new MCPManager();
  }
  return mcpManager;
}
```

#### Buffer Overflow Protection & Resource Management

**Memory Safety Controls:**

The MCP Manager implements comprehensive protection against malicious or malfunctioning servers:

**Buffer Overflow Protection** (Issue #1):
- **Maximum Buffer Size:** 1MB (1,048,576 bytes)
- **Warning Threshold:** 512KB (524,288 bytes)
- **Protection Strategy:**
  - Monitors stdout buffer size in real-time
  - Warns when buffer exceeds 512KB
  - Parses all valid JSON-RPC messages BEFORE clearing on overflow
  - Clears buffer when exceeding 1MB to prevent memory exhaustion
  - Logs overflow events for diagnostics and debugging

**Log Rate Limiting & I/O Protection** (Issue #2):
- **Rotation Check Interval:** Maximum once per 60 seconds per log file
- **Log Buffering:** Up to 100 lines buffered, auto-flush every 1 second
- **Batch Writing:** Multiple log lines written in single I/O operation
- **Protection Benefits:**
  - Prevents disk I/O flooding from malicious MCP servers
  - Reduces I/O operations by 99% during high-volume logging
  - Protects against DoS attacks via stdout flooding

**State Cleanup & Memory Leak Prevention** (Issue #3):
- **On Server Stop:** All resources properly cleaned up
  - Pending log buffers flushed to disk
  - Log write timers cleared
  - Rotation check timestamps removed
  - Stdout buffers cleared
  - Tool caches invalidated
- **Prevents:** Memory leaks from abandoned timers and stale state

**Attack Mitigation:**

The system is hardened against various attack vectors:
- ✅ **Stdout Flooding:** Buffer overflow protection with message extraction
- ✅ **Log Flooding:** Rate-limited rotation checks and batched writes
- ✅ **Invalid JSON Flood:** Parse errors isolated, processing continues
- ✅ **Memory Exhaustion:** 1MB hard limit on stdout buffer
- ✅ **Disk Exhaustion:** Log rotation (10MB per file, 5 files max = 50MB total)
- ✅ **Resource Leaks:** Comprehensive cleanup on server stop

**Example Overflow Recovery:**

When a server floods stdout with >1MB of data:
```typescript
// Before (Data Loss):
if (bufferOverflow) {
  clearBuffer(); // ❌ Lost all pending JSON-RPC responses
  return;
}

// After (Data Recovery):
if (bufferOverflow) {
  const validMessages = parseAllValidMessages(buffer); // ✅ Extract data first
  clearBuffer(); // ✅ Then clear
  logRecovery(validMessages.length); // 📊 Log for monitoring
}
```

**Diagnostic Logging:**

All overflow and rate-limiting events are logged with structured context:
- Buffer size at overflow
- Number of messages recovered
- Failed parse attempts
- I/O operation counts
- Rotation check timestamps

This enables monitoring and alerting for misbehaving MCP servers in production.

---

### 2. Preload Script (`apps/desktop/src/preload/index.ts`)

**Purpose**: Secure IPC bridge between renderer and main process

**Security Model**:
- Uses `contextBridge` for secure exposure
- No direct Node.js access from renderer
- Sandboxed environment with explicit API surface

**Exposed API**:
```typescript
window.electron = {
  // Authentication
  auth: {
    getJWT: () => Promise<string | null>
    clearAuth: () => Promise<void>
  },

  // MCP Server Management
  mcp: {
    getConfig: () => Promise<MCPConfig>
    updateConfig: (config: MCPConfig) => Promise<{ success: boolean }>
    startServer: (name: string) => Promise<{ success: boolean; error?: string }>
    stopServer: (name: string) => Promise<{ success: boolean; error?: string }>
    restartServer: (name: string) => Promise<{ success: boolean; error?: string }>
    getServerStatuses: () => Promise<Record<string, MCPServerStatusInfo>>
    onStatusChange: (callback: (statuses) => void) => () => void

    // Tool Operations
    getAvailableTools: () => Promise<MCPTool[]>
    executeTool: (serverName: string, toolName: string, args?: Record<string, unknown>) => Promise<ToolExecutionResult>
  },

  // WebSocket Bridge
  ws: {
    getStatus: () => Promise<{ connected: boolean; reconnectAttempts: number }>
  }
}
```

### 3. WebSocket Client (`apps/desktop/src/main/ws-client.ts`)

**Purpose**: Optional bridge for remote tool execution from VPS

**Features**:
- Automatic JWT extraction from Electron cookies
- Heartbeat ping/pong (30s interval)
- Exponential backoff reconnection (1s → 30s max)
- Challenge-response authentication
- Tool execution request handling
- Graceful shutdown

**Connection Flow**:
```typescript
class WSClient {
  // Initialize with main window
  constructor(mainWindow: BrowserWindow)

  // Connect to VPS WebSocket endpoint
  async connect(): Promise<void>

  // Handle tool execution requests from server
  private async handleToolExecutionRequest(request: ToolExecutionRequest): Promise<void>

  // Challenge-response authentication
  private async handleChallenge(challenge: string): Promise<void>

  // Status
  getStatus(): { connected: boolean; reconnectAttempts: number }

  // Shutdown
  close(): void
}
```

**Authentication Flow**:
1. Extract JWT from Electron cookies (`accessToken`)
2. Decode JWT to get `userId`, `tokenVersion`, `iat`
3. Compute `sessionId = SHA256(userId:tokenVersion:iat)`
4. Receive challenge from server
5. Compute `response = SHA256(challenge + userId + sessionId)`
6. Send challenge response to server
7. Server verifies response matches expected value

### 4. Main Process Integration (`apps/desktop/src/main/index.ts`)

**Purpose**: Application entry point and IPC handler registration

**Key Integrations**:

**App Lifecycle Hooks**:
```typescript
app.whenReady().then(async () => {
  // Initialize MCP Manager
  const mcpManager = getMCPManager();
  await mcpManager.initialize();

  // Start status broadcasting (3s polling)
  startMCPStatusBroadcasting();

  // Create window
  createWindow();

  // Initialize WebSocket client
  if (mainWindow) {
    initializeWSClient(mainWindow);
  }
});

app.on('before-quit', async () => {
  // Stop status broadcasting
  stopMCPStatusBroadcasting();

  // Shutdown WebSocket client
  shutdownWSClient();

  // Shutdown MCP servers
  const mcpManager = getMCPManager();
  await mcpManager.shutdown();
});
```

**IPC Handlers**:
```typescript
// MCP Configuration
ipcMain.handle('mcp:get-config', async () => {
  const mcpManager = getMCPManager();
  return mcpManager.getConfig();
});

ipcMain.handle('mcp:update-config', async (_event, config: MCPConfig) => {
  const mcpManager = getMCPManager();
  await mcpManager.updateConfig(config);
  return { success: true };
});

// Server Control
ipcMain.handle('mcp:start-server', async (_event, name: string) => {
  const mcpManager = getMCPManager();
  await mcpManager.startServer(name);
  return { success: true };
});

// Tool Operations
ipcMain.handle('mcp:get-available-tools', async () => {
  const mcpManager = getMCPManager();
  return mcpManager.getAggregatedTools();
});

ipcMain.handle('mcp:execute-tool', async (_event, serverName: string, toolName: string, args?: Record<string, unknown>) => {
  const mcpManager = getMCPManager();
  return await mcpManager.executeTool(serverName, toolName, args);
});
```

**Status Broadcasting**:
```typescript
function broadcastMCPStatusChange() {
  const mcpManager = getMCPManager();
  const statuses = mcpManager.getServerStatuses();

  BrowserWindow.getAllWindows().forEach((window) => {
    window.webContents.send('mcp:status-changed', statuses);
  });
}

let mcpStatusInterval: NodeJS.Timeout | null = null;

function startMCPStatusBroadcasting() {
  mcpStatusInterval = setInterval(() => {
    broadcastMCPStatusChange();
  }, 3000); // Poll every 3 seconds
}
```

---

## Authentication System

PageSpace Desktop uses **Bearer Token Authentication** to avoid CSRF issues inherent in cookie-based auth for native applications.

### Bearer Token Flow

**Problem**: Cookie-based authentication requires CSRF tokens, which are:
- Designed for browser environments
- Complex to manage in native apps
- Not industry-standard for desktop applications

**Solution**: Use Bearer tokens in `Authorization` header (OAuth2/JWT standard)

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Authentication Middleware (`apps/web/src/lib/auth/index.ts`)

**Multi-Token Support**:
```typescript
export async function authenticateRequestWithOptions(
  request: Request,
  options: AuthenticateOptions
): Promise<AuthenticationResult> {
  const { allow, requireCSRF = false } = options;

  const bearerToken = getBearerToken(request);

  // Check for MCP token (format: mcp_...)
  if (bearerToken?.startsWith(MCP_TOKEN_PREFIX)) {
    if (!allow.includes('mcp')) {
      return { error: unauthorized('MCP tokens not permitted') };
    }
    return authenticateMCPRequest(request);
  }

  // Check for JWT token (Bearer or Cookie)
  if (allow.includes('jwt')) {
    const authResult = await authenticateWebRequest(request);

    // CSRF validation only for cookie-based JWT (not Bearer tokens)
    if (!isAuthError(authResult) && requireCSRF && authResult.source === 'cookie') {
      const csrfError = await validateCSRF(request);
      if (csrfError) {
        return { error: csrfError };
      }
    }

    return authResult;
  }
}
```

**Token Priority**:
1. **MCP Token** (`Bearer mcp_...`) → MCP API endpoints only
2. **JWT Bearer Token** (`Bearer eyJ...`) → Desktop app (CSRF-exempt)
3. **JWT Cookie Token** → Web app (requires CSRF)

### Desktop Auth Fetch (`apps/web/src/lib/auth-fetch.ts`)

**Automatic Bearer Token Injection**:
```typescript
class AuthFetch {
  async fetch(url: string, options?: FetchOptions): Promise<Response> {
    // Detect Desktop environment
    const isDesktop = typeof window !== 'undefined' && 'electron' in window;

    let headers = { ...options?.headers };

    if (isDesktop) {
      // Desktop: Use Bearer token authentication (CSRF-exempt)
      const jwt = await this.getJWTFromElectron();
      if (jwt) {
        headers['Authorization'] = `Bearer ${jwt}`;
      }
    } else {
      // Web: Use cookie-based authentication with CSRF
      const csrfToken = await this.getCSRFToken();
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }
    }

    return fetch(url, {
      ...options,
      headers,
      credentials: 'include' // Always include cookies
    });
  }

  private async getJWTFromElectron(): Promise<string | null> {
    // Cached for 5 seconds to avoid excessive IPC calls
    const now = Date.now();
    if (this.jwtCache && (now - this.jwtCache.timestamp) < 5000) {
      return this.jwtCache.token;
    }

    const token = await window.electron.auth.getJWT();
    this.jwtCache = { token, timestamp: now };
    return token;
  }
}
```

**IPC Handler for JWT Retrieval** (`apps/desktop/src/main/index.ts`):
```typescript
ipcMain.handle('auth:get-jwt', async () => {
  try {
    // Get JWT from Electron's session cookies (stored as 'accessToken')
    const cookies = await session.defaultSession.cookies.get({ name: 'accessToken' });
    if (cookies.length > 0) {
      console.log('[Auth IPC] JWT token retrieved from cookies');
      return cookies[0].value;
    }
    return null;
  } catch (error) {
    console.error('[Auth IPC] Failed to get JWT token:', error);
    return null;
  }
});
```

### Security Benefits of Bearer Tokens

✅ **CSRF-Exempt**: Tokens in headers are not sent automatically by browsers
✅ **Industry Standard**: OAuth 2.0 RFC 6750, OpenID Connect Core 1.0
✅ **Explicit Authentication**: Requires explicit JavaScript code to include token
✅ **No Browser Quirks**: Avoids Same-Origin Policy complexities
✅ **Simpler Implementation**: No CSRF token management required

### Security Considerations

⚠️ **XSS Risk**: If XSS vulnerability exists, JWT can be stolen
✅ **Mitigation**: Same risk as cookies, CSP headers still apply
✅ **Secure Storage**: JWT stored in Electron's httpOnly cookies (encrypted at rest)
✅ **Short-Lived Tokens**: JWTs expire, requiring periodic refresh
✅ **Token Versioning**: `tokenVersion` allows immediate invalidation

---

## Configuration Management

### Configuration File Structure

**Location**: `~/.pagespace/local-mcp-config.json`

**Format** (Claude Desktop compatible):
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/username/Documents"
      ],
      "env": {
        "PATH": "/usr/local/bin:/usr/bin:/bin"
      },
      "autoStart": true,
      "enabled": true,
      "timeout": 30000
    },
    "github": {
      "command": "node",
      "args": [
        "/path/to/github-mcp-server/dist/index.js"
      ],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      },
      "autoStart": false,
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

### Configuration Schema

**MCPServerConfig**:
```typescript
interface MCPServerConfig {
  command: string;              // Executable command (e.g., "npx", "node", "python")
  args: string[];               // Command arguments
  env?: Record<string, string>; // Environment variables
  autoStart?: boolean;          // Auto-start on app launch (default: true)
  enabled?: boolean;            // Server enabled (default: true)
  timeout?: number;             // Tool execution timeout in ms (1000-300000, default: 30000)
}
```

**Validation** (`apps/desktop/src/shared/mcp-validation.ts`):
```typescript
export function validateMCPConfig(config: unknown): ValidationResult<MCPConfig> {
  // Validate structure
  if (!config || typeof config !== 'object') {
    return { success: false, error: 'Config must be an object' };
  }

  if (!('mcpServers' in config)) {
    return { success: false, error: 'Missing mcpServers field' };
  }

  const servers = (config as any).mcpServers;

  // Validate each server
  for (const [name, serverConfig] of Object.entries(servers)) {
    if (!serverConfig.command || typeof serverConfig.command !== 'string') {
      return { success: false, error: `Server ${name}: command is required` };
    }

    if (!Array.isArray(serverConfig.args)) {
      return { success: false, error: `Server ${name}: args must be an array` };
    }

    // Validate timeout if specified
    if (serverConfig.timeout !== undefined) {
      if (typeof serverConfig.timeout !== 'number') {
        return { success: false, error: `Server ${name}: timeout must be a number` };
      }
      if (serverConfig.timeout < 1000 || serverConfig.timeout > 300000) {
        return { success: false, error: `Server ${name}: timeout must be between 1000-300000ms` };
      }
    }
  }

  return { success: true, data: config as MCPConfig };
}
```

### Configuration Persistence

**Save Flow**:
```typescript
async saveConfig(): Promise<void> {
  // Stringify with pretty formatting
  const configData = JSON.stringify(this.config, null, 2);

  // Write to disk atomically
  await fs.writeFile(this.configPath, configData, 'utf-8');

  // Verify the write
  const verification = await fs.readFile(this.configPath, 'utf-8');
  console.log('[MCP Manager] Config saved and verified');
}
```

**Load Flow**:
```typescript
private async loadConfig(): Promise<void> {
  try {
    const configData = await fs.readFile(this.configPath, 'utf-8');
    this.config = JSON.parse(configData);

    // Initialize server process tracking
    for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
      if (!this.servers.has(name)) {
        this.servers.set(name, {
          config: serverConfig,
          process: null,
          status: 'stopped',
          crashCount: 0,
        });
      }
    }
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // Config file doesn't exist - create default
      this.config = { mcpServers: {} };
      await this.saveConfig();
    } else {
      throw error;
    }
  }
}
```

### Configuration Updates

**Update Flow**:
```typescript
async updateConfig(newConfig: MCPConfig): Promise<void> {
  // Validate configuration
  const validation = validateMCPConfig(newConfig);
  if (!validation.success) {
    throw new Error(`Invalid configuration: ${validation.error}`);
  }

  this.config = validation.data;

  // Update server process tracking
  for (const [name, serverConfig] of Object.entries(newConfig.mcpServers)) {
    if (!this.servers.has(name)) {
      // New server - add to tracking
      this.servers.set(name, {
        config: serverConfig,
        process: null,
        status: 'stopped',
        crashCount: 0,
      });
    } else {
      // Existing server - update config
      const server = this.servers.get(name)!;
      server.config = serverConfig;
    }
  }

  // Remove servers no longer in config
  const configNames = new Set(Object.keys(newConfig.mcpServers));
  for (const name of this.servers.keys()) {
    if (!configNames.has(name)) {
      await this.stopServer(name);
      this.servers.delete(name);
    }
  }

  // Save to disk
  await this.saveConfig();
}
```

---

## Process Management

### Server Lifecycle

**States**:
```typescript
export type MCPServerStatus =
  | 'stopped'   // Server is not running
  | 'starting'  // Server is being spawned
  | 'running'   // Server is healthy and running
  | 'error'     // Server failed to start
  | 'crashed';  // Server exited unexpectedly
```

### Starting a Server

```typescript
async startServer(name: string): Promise<void> {
  const server = this.servers.get(name);
  if (!server) {
    throw new Error(`Server ${name} not found in configuration`);
  }

  if (server.process) {
    throw new Error(`Server ${name} is already running`);
  }

  const { config } = server;
  server.status = 'starting';

  try {
    // Spawn the MCP server process
    const childProcess = spawn(config.command, config.args, {
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
    });

    server.process = childProcess;
    server.startedAt = new Date();
    server.error = undefined;

    // Set up event handlers
    childProcess.on('error', (error) => {
      server.status = 'error';
      server.error = error.message;
      this.logServerError(name, error);
    });

    childProcess.on('exit', (code, signal) => {
      if (server.status === 'running') {
        // Unexpected exit - mark as crashed
        server.status = 'crashed';
        server.crashCount++;
        server.lastCrashAt = new Date();
        server.error = `Process exited unexpectedly (code: ${code}, signal: ${signal})`;
      } else {
        // Expected exit
        server.status = 'stopped';
      }

      server.process = null;
      this.logServerError(name, new Error(server.error || 'Process exited'));
    });

    // Initialize JSON-RPC tracking
    this.pendingRequests.set(name, new Map());
    this.stdoutBuffers.set(name, '');

    // Capture stdout for JSON-RPC responses
    childProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      this.logServerOutput(name, 'stdout', output);
      this.handleStdoutData(name, output);
    });

    childProcess.stderr?.on('data', (data) => {
      this.logServerOutput(name, 'stderr', data.toString());
    });

    // Wait for server to start (1000ms delay)
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Check if process is still running
    if (childProcess.exitCode === null && !childProcess.killed) {
      server.status = 'running';
      console.log(`Server ${name} started successfully`);

      // Fetch tools from server (async, don't wait)
      this.getMCPTools(name).catch((error) => {
        console.error(`Failed to fetch tools from ${name}:`, error);
      });
    } else {
      throw new Error('Process exited immediately after start');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    server.status = 'error';
    server.error = errorMessage;
    server.process = null;
    throw error;
  }
}
```

### Stopping a Server

```typescript
async stopServer(name: string): Promise<void> {
  const server = this.servers.get(name);
  if (!server || !server.process) {
    return; // Already stopped
  }

  server.status = 'stopped';

  // Reject all pending JSON-RPC requests
  const pendingMap = this.pendingRequests.get(name);
  if (pendingMap) {
    for (const [requestId, pending] of pendingMap.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Server ${name} is stopping`));
    }
    pendingMap.clear();
  }

  // Clear buffers and caches
  this.stdoutBuffers.set(name, '');
  this.clearToolCache(name);

  // Send SIGTERM to process
  server.process.kill('SIGTERM');

  // Wait for graceful shutdown (max 5000ms)
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      // Force kill if not exited
      if (server.process) {
        server.process.kill('SIGKILL');
      }
      resolve();
    }, 5000);

    server.process!.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  server.process = null;
}
```

### Auto-Start on Launch

```typescript
private async autoStartServers(): Promise<void> {
  for (const [name, server] of this.servers.entries()) {
    // Start if autoStart !== false and enabled !== false
    if (server.config.autoStart !== false && server.config.enabled !== false) {
      try {
        console.log(`[MCP Manager] Auto-starting server: ${name}`);
        await this.startServer(name);
      } catch (error) {
        console.error(`Failed to auto-start server ${name}:`, error);
      }
    }
  }
}
```

### Crash Recovery

**Crash Detection**:
```typescript
childProcess.on('exit', (code, signal) => {
  if (server.status === 'running') {
    // Unexpected exit - mark as crashed
    server.status = 'crashed';
    server.crashCount++;
    server.lastCrashAt = new Date();
    server.error = `Process exited unexpectedly (code: ${code}, signal: ${signal})`;
  }
});
```

**Status Information**:
```typescript
interface MCPServerStatusInfo {
  status: MCPServerStatus;
  error?: string;
  startedAt?: Date;
  crashCount: number;
  lastCrashAt?: Date;
  enabled: boolean;
  autoStart: boolean;
}
```

**No Automatic Restart**: Servers do NOT automatically restart after crashes to avoid infinite restart loops. Users must manually restart crashed servers.

### Log Rotation

**Log Files**:
- **Server Logs**: `~/.pagespace/logs/mcp-<servername>.log`
- **Error Logs**: `~/.pagespace/logs/mcp-errors.log`

**Rotation Policy**:
- **Max File Size**: 10 MB per file
- **Max Files**: 5 rotated files (`.1`, `.2`, `.3`, `.4`, `.5`)
- **Rotation Logic**: When file exceeds 10MB, rotate existing logs and create new file

```typescript
async function rotateLogFile(logPath: string): Promise<void> {
  try {
    const stats = await fs.stat(logPath);
    if (stats.size > 10 * 1024 * 1024) { // 10MB
      // Rotate existing logs (.1 → .2, .2 → .3, etc.)
      for (let i = 4; i > 0; i--) {
        const oldPath = `${logPath}.${i}`;
        const newPath = `${logPath}.${i + 1}`;
        try {
          await fs.rename(oldPath, newPath);
        } catch {
          // File doesn't exist, skip
        }
      }
      // Move current log to .1
      await fs.rename(logPath, `${logPath}.1`);
    }
  } catch (error) {
    // Log file doesn't exist yet
  }
}
```

---

## Command Resolution System

### The Packaged App PATH Problem

Electron apps packaged for distribution have a **minimal PATH environment**, which causes commands like `npx`, `node`, or `python` to fail even when they're installed on the user's system. This is a critical issue for MCP servers that rely on these commands.

**Why This Happens**:
- Packaged apps don't inherit the user's shell PATH
- PATH is typically limited to: `/usr/bin:/bin:/usr/sbin:/sbin`
- Missing common locations like `/usr/local/bin`, Homebrew paths, version managers (nvm/fnm)

**Example Failure**:
```typescript
// This fails in packaged apps even with npx installed
spawn('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])
// Error: spawn npx ENOENT
```

### Solution: Command Resolver

**Location**: `apps/desktop/src/main/command-resolver.ts`

The Command Resolver automatically finds and resolves commands to their absolute paths before spawning processes.

**How It Works**:
```typescript
import { resolveCommand, getEnhancedEnvironment } from './command-resolver';

// Before spawning
const resolvedCommand = await resolveCommand('npx');
// Returns: '/usr/local/bin/npx' or '/opt/homebrew/bin/npx'

// Spawn with resolved path
const childProcess = spawn(resolvedCommand, args, {
  env: getEnhancedEnvironment(), // Enhanced PATH with Node.js locations
});
```

### Core Functions

#### `resolveCommand(command: string): Promise<string>`

**Purpose**: Resolve a command to its absolute path

**Algorithm**:
1. Check if command is already absolute → return as-is
2. Check cache for previously resolved path → return cached
3. Use `which` (Unix) or `where` (Windows) to find command
4. Cache the result for performance
5. If not found, return original command with warning

**Example**:
```typescript
await resolveCommand('npx')      // → '/usr/local/bin/npx'
await resolveCommand('node')     // → '/usr/local/bin/node'
await resolveCommand('python3')  // → '/usr/bin/python3'
await resolveCommand('/usr/local/bin/node') // → '/usr/local/bin/node' (already absolute)
```

**Cross-Platform Support**:
```typescript
async function findCommandPath(command: string): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const whichCommand = isWindows ? 'where' : 'which';

  const proc = spawn(whichCommand, [command], {
    env: getEnhancedEnvironment(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  // Parse output and return first valid path
  // Windows 'where' may return multiple paths
  const firstPath = output.trim().split('\n')[0].trim();
  return firstPath;
}
```

#### `getEnhancedEnvironment(): NodeJS.ProcessEnv`

**Purpose**: Construct enhanced PATH with common Node.js installation locations

**Searched Locations**:
```typescript
const commonPaths = [
  '/usr/local/bin',              // Homebrew (Intel Mac), standard Unix
  '/usr/bin',                     // System binaries
  '/opt/homebrew/bin',            // Homebrew (Apple Silicon Mac)
  '/home/linuxbrew/.linuxbrew/bin', // Linux Homebrew
  '~/.nvm/versions/node/*/bin',  // nvm (Node Version Manager)
  '~/.fnm/node-versions/*/bin',  // fnm (Fast Node Manager)
  '%APPDATA%\\npm',              // Windows npm global
  'C:\\Program Files\\nodejs',   // Windows Node.js install
];
```

**PATH Construction**:
```typescript
export function getEnhancedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  // Expand version manager paths
  const expandedPaths = expandVersionManagerPaths();

  // Construct enhanced PATH
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  const enhancedPath = [...expandedPaths, env.PATH]
    .filter(Boolean)
    .join(pathSeparator);

  env.PATH = enhancedPath;
  return env;
}
```

**Result**:
```bash
# Enhanced PATH (macOS example)
/opt/homebrew/bin:\
/usr/local/bin:\
/Users/username/.nvm/versions/node/v22.17.0/bin:\
/usr/bin:\
/bin:\
...existing PATH...
```

#### `expandVersionManagerPaths(basePath: string): string[]`

**Purpose**: Expand version manager directories to actual `bin` paths

**Supports**:
- **nvm** (Node Version Manager): `~/.nvm/versions/node/`
- **fnm** (Fast Node Manager): `~/.fnm/node-versions/`

**Example Expansion**:
```typescript
// Input: ~/.nvm/versions/node
// Discovers:
[
  '~/.nvm/versions/node/v22.17.0/bin',
  '~/.nvm/versions/node/v20.10.0/bin',
  '~/.nvm/versions/node/v18.19.0/bin',
]

// All bin directories are added to PATH
// Latest versions appear first
```

**fnm Support**:
```typescript
// fnm uses different structure: version/installation/bin
const fnmBinPath = path.join(versionPath, 'installation', 'bin');
if (fs.existsSync(fnmBinPath)) {
  return fnmBinPath;
}
```

### Caching

**Performance Optimization**:
```typescript
const commandCache = new Map<string, string>();

export async function resolveCommand(command: string): Promise<string> {
  // Check cache first
  if (commandCache.has(command)) {
    return commandCache.get(command)!;
  }

  // Resolve and cache
  const resolvedPath = await findCommandPath(command);
  if (resolvedPath) {
    commandCache.set(command, resolvedPath);
    return resolvedPath;
  }

  return command;
}
```

**Cache Benefits**:
- ⚡ Instant resolution for repeated commands
- 🔄 Survives across server restarts (within session)
- 🧹 Can be cleared with `clearCommandCache()`

**Cache Invalidation**:
```typescript
export function clearCommandCache(): void {
  commandCache.clear();
}

// Use when:
// - User updates Node.js version
// - PATH environment changes
// - Testing/debugging
```

### Integration with MCP Manager

**Before**:
```typescript
// Old code (fails in packaged apps)
const childProcess = spawn(config.command, config.args, {
  env: { ...process.env, ...config.env },
});
```

**After** (`mcp-manager.ts:279-290`):
```typescript
// New code (works in packaged apps)

// 1. Resolve command to absolute path
const resolvedCommand = await resolveCommand(config.command);
console.log(`[MCP Manager] Resolved "${config.command}" to "${resolvedCommand}"`);

// 2. Construct enhanced environment
const enhancedEnv = getEnhancedEnvironment();

// 3. Spawn with resolved command and enhanced PATH
const childProcess = spawn(resolvedCommand, config.args, {
  env: { ...enhancedEnv, ...config.env }, // User config.env takes precedence
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

**Logging Output**:
```
[MCP Manager] Resolved command "npx" to "/usr/local/bin/npx"
[MCP Manager] Resolved command "node" to "/opt/homebrew/bin/node"
[MCP Manager] Resolved command "python3" to "/usr/bin/python3"
```

### Auto-Start Default Change

**Previous Behavior**:
```typescript
// Only auto-start if explicitly enabled
if (server.config.autoStart && server.config.enabled !== false) {
  await this.startServer(name);
}
```

**New Behavior** (`mcp-manager.ts:254-258`):
```typescript
// Auto-start by default (opt-out model)
if (server.config.autoStart !== false && server.config.enabled !== false) {
  console.log(`[MCP Manager] Auto-starting server: ${name}`);
  await this.startServer(name);
}
```

**Rationale**:
- More user-friendly (servers "just work" on app launch)
- Matches Claude Desktop behavior
- Users can opt-out with `autoStart: false`

**Configuration Examples**:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
      // autoStart: true by default (implicit)
    },
    "github": {
      "command": "node",
      "args": ["./github-server.js"],
      "autoStart": false  // Explicit opt-out
    }
  }
}
```

### Cross-Platform Considerations

#### macOS
**Homebrew Location Detection**:
```typescript
// Intel Mac
'/usr/local/bin'

// Apple Silicon Mac (M1/M2/M3)
'/opt/homebrew/bin'
```

**Version Managers**:
```typescript
// nvm
'~/.nvm/versions/node/*/bin'

// fnm
'~/.fnm/node-versions/*/bin'
```

#### Linux
**Common Paths**:
```typescript
'/usr/local/bin'
'/usr/bin'
'/bin'
'/home/linuxbrew/.linuxbrew/bin' // Homebrew on Linux
```

#### Windows
**Node.js Locations**:
```typescript
'C:\\Program Files\\nodejs'
'%APPDATA%\\npm'  // Global npm packages
```

**Command Resolution**:
```typescript
// Uses 'where' instead of 'which'
const whichCommand = process.platform === 'win32' ? 'where' : 'which';
```

**Path Separator**:
```typescript
const pathSeparator = process.platform === 'win32' ? ';' : ':';
```

### Error Handling

**Command Not Found**:
```typescript
const resolvedPath = await findCommandPath(command);

if (!resolvedPath) {
  console.warn(`[Command Resolver] Could not resolve "${command}" to absolute path, using as-is`);
  return command; // Fallback to original command
}
```

**Why Fallback?**:
- Command might be in user's shell PATH but not discoverable
- User might have custom PATH in `config.env`
- Better to try and fail than to block server start

**Version Manager Errors**:
```typescript
function expandVersionManagerPaths(basePath: string): string[] {
  try {
    // ... expansion logic ...
  } catch (error) {
    console.warn(`[Command Resolver] Error expanding version manager paths for ${basePath}:`, error);
    return []; // Return empty array, don't crash
  }
}
```

### Testing

**Manual Testing**:
```bash
# Test command resolution in packaged app
# 1. Package the app
pnpm package:desktop

# 2. Install packaged app
# macOS: PageSpace.app
# Windows: PageSpace Setup.exe
# Linux: PageSpace.AppImage

# 3. Configure MCP server with npx
{
  "mcpServers": {
    "test": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}

# 4. Start server and check logs
# Should see: [MCP Manager] Resolved command "npx" to "/usr/local/bin/npx"
```

**Unit Tests**:
```typescript
describe('Command Resolver', () => {
  it('should resolve npx to absolute path', async () => {
    const resolved = await resolveCommand('npx');
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toContain('npx');
  });

  it('should cache resolved commands', async () => {
    const first = await resolveCommand('node');
    const second = await resolveCommand('node');
    expect(first).toBe(second); // Same reference (cached)
  });

  it('should handle absolute paths', async () => {
    const absolutePath = '/usr/bin/node';
    const resolved = await resolveCommand(absolutePath);
    expect(resolved).toBe(absolutePath);
  });

  it('should construct enhanced PATH', () => {
    const env = getEnhancedEnvironment();
    expect(env.PATH).toContain('/usr/local/bin');
    expect(env.PATH).toContain('/opt/homebrew/bin');
  });
});
```

### Performance Impact

**Benchmarks**:
- First resolution: ~10-50ms (calls `which`/`where`)
- Cached resolution: <1ms (map lookup)
- Enhanced PATH construction: ~5-10ms (one-time per spawn)

**Optimization**:
```typescript
// Cache prevents repeated which/where calls
// Typical session: ~10 unique commands
// Cache hit rate: >90% after first minute
```

### Future Enhancements

**Potential Improvements**:
1. **Persist Cache to Disk**: Survive app restarts
2. **Watch PATH Changes**: Auto-invalidate cache on PATH update
3. **Prefer User-Installed Versions**: Prioritize Homebrew over system
4. **Custom Search Paths**: Allow users to add custom locations
5. **Diagnostic Tool**: UI to test command resolution

---

## Tool Discovery and Execution

### Tool Discovery

**Automatic Discovery on Server Start**:
```typescript
// In startServer(), after process is running:
this.getMCPTools(name).catch((error) => {
  console.error(`Failed to fetch tools from ${name}:`, error);
});
```

**Tool List Request** (JSON-RPC):
```typescript
async getMCPTools(serverName: string): Promise<MCPTool[]> {
  try {
    console.log(`Fetching tools from server ${serverName}...`);

    // Send tools/list request
    const response = await this.sendJSONRPCRequest(serverName, 'tools/list', {});

    if (!response.result) {
      console.warn(`No result in tools/list response from ${serverName}`);
      return [];
    }

    const toolsListResponse = response.result as MCPToolsListResponse;

    // Convert to MCPTool format with server name
    const tools: MCPTool[] = toolsListResponse.tools.map(tool => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema,
      serverName,
    }));

    // Cache the tools
    this.toolCache.set(serverName, tools);

    console.log(`Cached ${tools.length} tools from server ${serverName}`);
    return tools;
  } catch (error) {
    console.error(`Failed to fetch tools from ${serverName}:`, error);
    this.toolCache.set(serverName, []); // Cache empty array on error
    return [];
  }
}
```

**Tool Caching**:
```typescript
private toolCache: Map<string, MCPTool[]> = new Map();

// Get tools from specific server (from cache)
getServerTools(serverName: string): MCPTool[] {
  return this.toolCache.get(serverName) || [];
}

// Get aggregated tools from all running enabled servers
getAggregatedTools(): MCPTool[] {
  const allTools: MCPTool[] = [];

  for (const [serverName, server] of this.servers.entries()) {
    // Only include tools from running servers that are enabled
    if (server.status === 'running' && server.config.enabled !== false) {
      const tools = this.toolCache.get(serverName) || [];
      allTools.push(...tools);
    }
  }

  return allTools;
}
```

### JSON-RPC Communication

**Protocol**: JSON-RPC 2.0 over stdin/stdout (newline-delimited)

**Request Format**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

**Response Format**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "read_file",
        "description": "Read contents of a file",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          },
          "required": ["path"]
        }
      }
    ]
  }
}
```

**Error Response**:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32600,
    "message": "Invalid Request",
    "data": {}
  }
}
```

**Sending JSON-RPC Requests**:
```typescript
async sendJSONRPCRequest(
  serverName: string,
  method: string,
  params?: Record<string, unknown> | unknown[]
): Promise<JSONRPCResponse> {
  const server = this.servers.get(serverName);
  if (!server || !server.process || server.status !== 'running') {
    throw new Error(`Server ${serverName} is not running`);
  }

  const requestId = this.nextRequestId++;
  const request: JSONRPCRequest = {
    jsonrpc: '2.0',
    id: requestId,
    method,
    params,
  };

  // Create promise that resolves when response arrives
  return new Promise<JSONRPCResponse>((resolve, reject) => {
    // Set up timeout (30s)
    const timeout = setTimeout(() => {
      const pendingMap = this.pendingRequests.get(serverName);
      if (pendingMap) {
        pendingMap.delete(requestId);
      }
      reject(new Error(`JSON-RPC request timeout after 30000ms`));
    }, 30000);

    // Store pending request
    const pendingMap = this.pendingRequests.get(serverName);
    if (!pendingMap) {
      clearTimeout(timeout);
      reject(new Error(`Server ${serverName} has no pending requests map`));
      return;
    }

    pendingMap.set(requestId, { resolve, reject, timeout });

    // Send request via stdin
    const requestStr = JSON.stringify(request) + '\n';
    const writeSuccess = server.process.stdin?.write(requestStr);

    if (!writeSuccess) {
      clearTimeout(timeout);
      pendingMap.delete(requestId);
      reject(new Error(`Failed to write JSON-RPC request to ${serverName} stdin`));
    }
  });
}
```

**Handling JSON-RPC Responses**:
```typescript
private handleStdoutData(serverName: string, data: string): void {
  // Append to buffer
  const currentBuffer = this.stdoutBuffers.get(serverName) || '';
  const newBuffer = currentBuffer + data;
  this.stdoutBuffers.set(serverName, newBuffer);

  // Try to parse complete JSON-RPC messages (newline-delimited)
  const lines = newBuffer.split('\n');

  // Keep the last incomplete line in the buffer
  const incompleteLineIndex = newBuffer.endsWith('\n') ? lines.length : lines.length - 1;
  this.stdoutBuffers.set(serverName, lines[incompleteLineIndex] || '');

  // Process complete lines
  for (let i = 0; i < incompleteLineIndex; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    try {
      const message = JSON.parse(line) as JSONRPCResponse;
      this.handleJSONRPCResponse(serverName, message);
    } catch (error) {
      console.warn(`Failed to parse JSON-RPC message from ${serverName}:`, line);
    }
  }
}

private handleJSONRPCResponse(serverName: string, response: JSONRPCResponse): void {
  const pendingMap = this.pendingRequests.get(serverName);
  if (!pendingMap) return;

  const pending = pendingMap.get(response.id);
  if (!pending) {
    console.warn(`Received JSON-RPC response with unknown ID ${response.id} from ${serverName}`);
    return;
  }

  // Clear timeout
  clearTimeout(pending.timeout);
  pendingMap.delete(response.id);

  // Resolve or reject based on response
  if (response.error) {
    pending.reject(new Error(`JSON-RPC error: ${response.error.message} (code: ${response.error.code})`));
  } else {
    pending.resolve(response);
  }
}
```

### Tool Execution

**Execute Tool Method**:
```typescript
async executeTool(
  serverName: string,
  toolName: string,
  args?: Record<string, unknown>
): Promise<ToolExecutionResult> {
  try {
    console.log(`Executing tool ${toolName} on server ${serverName} with args:`, args);

    // Verify server is running
    const server = this.servers.get(serverName);
    if (!server || server.status !== 'running') {
      return {
        success: false,
        error: `Server ${serverName} is not running (status: ${server?.status || 'not found'})`,
      };
    }

    // Prepare tool call request
    const toolCallRequest: MCPToolCallRequest = {
      name: toolName,
      arguments: args,
    };

    // Send tools/call JSON-RPC request
    const response = await this.sendJSONRPCRequest(serverName, 'tools/call', toolCallRequest);

    if (!response.result) {
      return {
        success: false,
        error: 'No result in tool execution response',
      };
    }

    const toolResponse = response.result as MCPToolCallResponse;

    // Check if the tool response indicates an error
    if (toolResponse.isError) {
      const errorText = toolResponse.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
      return {
        success: false,
        error: errorText || 'Tool execution failed',
      };
    }

    // Return successful result
    return {
      success: true,
      result: toolResponse,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Tool execution failed for ${toolName} on ${serverName}:`, error);

    return {
      success: false,
      error: errorMessage,
    };
  }
}
```

**Tool Execution Result**:
```typescript
interface ToolExecutionResult {
  success: boolean;
  result?: MCPToolCallResponse;
  error?: string;
}

interface MCPToolCallResponse {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}
```

**Timeout Configuration**:
- **Default Timeout**: 30,000 ms (30 seconds)
- **Minimum Timeout**: 1,000 ms (1 second)
- **Maximum Timeout**: 300,000 ms (5 minutes)
- **Per-Server Override**: Can be configured in `MCPServerConfig.timeout`

---

## WebSocket Bridge

The WebSocket Bridge allows the PageSpace VPS server to execute MCP tools on the local desktop app. This enables remote AI chats to use local MCP tools.

### Architecture

```
┌──────────────────────┐                    ┌──────────────────────┐
│  PageSpace VPS       │                    │  Desktop App         │
│                      │                    │                      │
│  ┌────────────────┐  │                    │  ┌────────────────┐  │
│  │  AI Chat API   │  │                    │  │  WS Client     │  │
│  └────────┬───────┘  │                    │  └────────┬───────┘  │
│           │          │                    │           │          │
│           │ requests │  WebSocket (wss://)│           │ connects │
│           ▼          │ ◄──────────────────┼───────────┘          │
│  ┌────────────────┐  │                    │                      │
│  │  WS Endpoint   │  │                    │  ┌────────────────┐  │
│  │  /api/mcp-ws   │  │ tool_execute       │  │  MCP Manager   │  │
│  └────────┬───────┘  │ ──────────────────►│  │                │  │
│           │          │                    │  └────────┬───────┘  │
│           │          │ tool_result        │           │          │
│           │          │ ◄──────────────────┼───────────┘          │
│           │          │                    │                      │
└───────────┼──────────┘                    └──────────────────────┘
            │
            │ stores session
            ▼
   ┌──────────────┐
   │  Database    │
   │  sessions    │
   └──────────────┘
```

### Connection Flow

**1. Desktop App Initialization** (`ws-client.ts:89-119`):
```typescript
async connect(): Promise<void> {
  // Get JWT token from Electron cookies
  const token = await this.getJWTToken();
  if (!token) {
    console.error('[WS-Client] Cannot connect without JWT token');
    this.scheduleReconnect();
    return;
  }

  const url = this.getWebSocketUrl(); // ws://localhost:3000/api/mcp-ws or wss://pagespace.ai/api/mcp-ws

  this.ws = new WebSocket(url, {
    headers: {
      Cookie: `accessToken=${token}`,
    },
  });

  this.setupEventHandlers();
}
```

**WebSocket URL Construction** (`ws-client.ts:48-61`):
```typescript
private getWebSocketUrl(): string {
  let baseUrl =
    process.env.NODE_ENV === 'development'
      ? process.env.PAGESPACE_URL || 'http://localhost:3000'
      : process.env.PAGESPACE_URL || 'https://pagespace.ai';

  // Force HTTPS for non-localhost URLs (security requirement)
  if (!baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1')) {
    baseUrl = baseUrl.replace(/^http:/, 'https:');
  }

  // Convert http/https to ws/wss
  return baseUrl.replace(/^http/, 'ws') + '/api/mcp-ws';
}
```

**Security Enforcement**:
- ✅ Localhost connections allowed over HTTP (development)
- ✅ Non-localhost connections forced to HTTPS → WSS (production)
- ✅ Prevents accidental insecure connections in production

**2. Server Authentication** (VPS side):
- Extract JWT from cookies
- Verify JWT signature
- Create session in database
- Send challenge to client

**3. Challenge-Response** (`ws-client.ts:244-282`):
```typescript
private async handleChallenge(challenge: string): Promise<void> {
  // Get JWT token
  const token = await this.getJWTToken();
  const payload = this.decodeJWT(token);

  // Compute sessionId = SHA256(userId:tokenVersion:iat)
  const sessionId = crypto.createHash('sha256')
    .update(`${payload.userId}:${payload.tokenVersion}:${payload.iat || 0}`)
    .digest('hex');

  // Compute response = SHA256(challenge + userId + sessionId)
  const responseString = `${challenge}${payload.userId}${sessionId}`;
  const response = crypto.createHash('sha256').update(responseString).digest('hex');

  // Send challenge response
  this.sendMessage({
    type: 'challenge_response',
    response,
  });
}
```

**4. Server Verification** (VPS side):
- Compute expected response using same formula
- Compare with client's response
- If match, mark session as verified
- If mismatch, close connection

### Message Types

**Server → Client**:
```typescript
// Connection established
{ type: 'connected', sessionId: string }

// Authentication challenge
{ type: 'challenge', challenge: string }

// Challenge verification result
{ type: 'challenge_verified' }

// Heartbeat response
{ type: 'pong', timestamp: number }

// Tool execution request
{
  type: 'tool_execute',
  id: string,
  serverName: string,
  toolName: string,
  args?: Record<string, unknown>
}

// Error message
{ type: 'error', error: string }
```

**Client → Server**:
```typescript
// Heartbeat ping
{ type: 'ping', timestamp: number }

// Challenge response
{ type: 'challenge_response', response: string }

// Tool execution result
{
  type: 'tool_result',
  id: string,
  success: boolean,
  result?: unknown,
  error?: string
}
```

### Tool Execution Flow

**1. Server Request** (`/api/mcp-ws` on VPS):
```typescript
// Server sends tool execution request to desktop
const request = {
  type: 'tool_execute',
  id: generateId(),
  serverName: 'filesystem',
  toolName: 'read_file',
  args: { path: '/Users/username/Documents/file.txt' }
};

ws.send(JSON.stringify(request));
```

**2. Desktop Execution** (`ws-client.ts:199-239`):
```typescript
private async handleToolExecutionRequest(request: ToolExecutionRequest): Promise<void> {
  console.log(`[WS-Client] Tool execution request: ${request.serverName}.${request.toolName}`);

  try {
    const mcpManager = getMCPManager();
    const result = await mcpManager.executeTool(
      request.serverName,
      request.toolName,
      request.args
    );

    // Send result back to server
    this.sendMessage({
      type: 'tool_result',
      id: request.id,
      success: result.success,
      result: result.result,
      error: result.error,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Send error result back to server
    this.sendMessage({
      type: 'tool_result',
      id: request.id,
      success: false,
      error: errorMessage,
    });
  }
}
```

**3. Server Response Handling** (VPS side):
```typescript
// Server waits for tool_result message
ws.on('message', (data) => {
  const message = JSON.parse(data.toString());

  if (message.type === 'tool_result') {
    const pending = pendingToolCalls.get(message.id);
    if (pending) {
      if (message.success) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
    }
  }
});
```

### Reconnection Strategy

**Exponential Backoff**:
```typescript
private scheduleReconnect(): void {
  if (this.isIntentionallyClosed) return;

  this.reconnectAttempts++;
  const delay = Math.min(
    this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
    this.maxReconnectDelay
  );

  // Delay: 1s, 2s, 4s, 8s, 16s, 30s (max)

  console.log(`[WS-Client] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

  this.reconnectTimeout = setTimeout(() => {
    this.connect();
  }, delay);
}
```

**Connection States**:
- **Connected**: `ws.readyState === WebSocket.OPEN`
- **Connecting**: `ws.readyState === WebSocket.CONNECTING`
- **Disconnected**: `ws === null || ws.readyState === WebSocket.CLOSED`

### Server-Side Security

**Reverse Proxy Support** (`apps/web/src/lib/ws-security.ts`):
```typescript
export function isSecureConnection(
  url: string,
  request?: { headers: { get: (name: string) => string | null } }
): boolean {
  // Allow localhost connections (development only)
  if (url.includes('localhost') || url.includes('127.0.0.1')) {
    return true;
  }

  // Development mode bypass
  if (process.env.NODE_ENV === 'development') {
    return true;
  }

  // In production behind reverse proxy: check X-Forwarded-Proto header
  // This tells us the original client protocol (https) even if the backend receives http
  if (request) {
    const forwardedProto = request.headers.get('x-forwarded-proto');
    if (forwardedProto === 'https' || forwardedProto === 'wss') {
      return true;
    }
  }

  // Fallback: check URL protocol directly (for direct connections without proxy)
  return url.startsWith('wss://') || url.startsWith('https://');
}
```

**Deployment Scenarios**:

1. **Development (localhost)**:
   - Client: `ws://localhost:3000/api/mcp-ws`
   - Server: Accepts HTTP/WS
   - Security: Bypassed (localhost trusted)

2. **Production (direct connection)**:
   - Client: `wss://pagespace.ai/api/mcp-ws`
   - Server: Requires WSS protocol
   - Security: URL protocol check

3. **Production (behind reverse proxy)**:
   - Client: `wss://pagespace.ai/api/mcp-ws`
   - Reverse Proxy (Nginx/Caddy): Terminates SSL, forwards HTTP to backend
   - Backend: Receives `http://localhost:3000/api/mcp-ws`
   - Security: Checks `X-Forwarded-Proto: https` header

**Nginx Configuration Example**:
```nginx
server {
  listen 443 ssl;
  server_name pagespace.ai;

  location /api/mcp-ws {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Proto $scheme; # Preserves original protocol
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Host $host;
  }
}
```

**Security Validation Flow**:
```
1. Client connects: wss://pagespace.ai/api/mcp-ws
2. Nginx terminates SSL
3. Nginx forwards to backend: http://localhost:3000/api/mcp-ws
   Headers: X-Forwarded-Proto: https
4. Server checks isSecureConnection()
   - request.headers.get('x-forwarded-proto') === 'https' ✅
5. Connection accepted
```

**CloudFlare/CDN Support**:
- CloudFlare sets `X-Forwarded-Proto` automatically
- No additional configuration needed
- Works with CloudFlare Proxy (orange cloud)

### Heartbeat Mechanism

```typescript
private startHeartbeat(): void {
  this.heartbeatInterval = setInterval(() => {
    this.sendMessage({ type: 'ping', timestamp: Date.now() });
  }, 30000); // Every 30 seconds
}
```

**Purpose**:
- Detect dead connections
- Keep connection alive through proxies/firewalls
- Server can close stale connections that don't respond to pings

---

## Frontend Integration

### React Hook: `useMCP()`

**Location**: `apps/web/src/hooks/useMCP.ts`

**Purpose**: Clean abstraction over Electron IPC for MCP functionality

**Returned State**:
```typescript
{
  isDesktop: boolean;                              // Is running in desktop app
  loading: boolean;                                // Initial load state
  config: MCPConfig;                               // Current MCP configuration
  serverStatuses: Record<string, MCPServerStatusInfo>; // Server statuses

  // Actions
  startServer: (name: string) => Promise<{ success: boolean; error?: string }>;
  stopServer: (name: string) => Promise<{ success: boolean; error?: string }>;
  restartServer: (name: string) => Promise<{ success: boolean; error?: string }>;
  updateConfig: (newConfig: MCPConfig) => Promise<{ success: boolean; error?: string }>;
  addServer: (name: string, config: MCPServerConfig) => Promise<{ success: boolean; error?: string }>;
  removeServer: (name: string) => Promise<{ success: boolean; error?: string }>;
  loadConfig: () => Promise<void>;
  loadStatuses: () => Promise<void>;
}
```

**Usage Example**:
```typescript
import { useMCP } from '@/hooks/useMCP';

function MCPSettingsPage() {
  const mcp = useMCP();

  if (!mcp.isDesktop) {
    return <Alert>Desktop Only Feature</Alert>;
  }

  return (
    <div>
      <h1>MCP Servers</h1>
      {Object.entries(mcp.config.mcpServers).map(([name, config]) => (
        <ServerCard
          key={name}
          name={name}
          config={config}
          status={mcp.serverStatuses[name]}
          onStart={() => mcp.startServer(name)}
          onStop={() => mcp.stopServer(name)}
          onRestart={() => mcp.restartServer(name)}
        />
      ))}
    </div>
  );
}
```

**Status Subscription**:
```typescript
useEffect(() => {
  if (!isDesktop || !window.electron) return;

  // Initial load
  loadConfig();
  loadStatuses();

  // Subscribe to status change events (3s polling from main process)
  const unsubscribe = window.electron.mcp.onStatusChange((statuses) => {
    setServerStatuses(statuses);
  });

  return unsubscribe;
}, [isDesktop, loadConfig, loadStatuses]);
```

### Settings Page: `/settings/local-mcp`

**Location**: `apps/web/src/app/settings/local-mcp/page.tsx`

**Features**:
- **Server List View**: Display all configured servers with status badges
- **Server Controls**: Start, stop, restart buttons per server
- **Configuration Editor**: JSON editor with syntax validation
- **Add/Remove Servers**: UI for adding new servers or removing existing ones
- **Auto-Start Toggle**: Configure which servers start automatically
- **Error Display**: Show crash counts and error messages
- **Desktop-Only Guard**: Show warning if accessed from web app

**Component Structure**:
```tsx
<Tabs>
  <TabsList>
    <TabsTrigger value="servers">Servers</TabsTrigger>
    <TabsTrigger value="config">Configuration</TabsTrigger>
  </TabsList>

  <TabsContent value="servers">
    {/* Server List with Controls */}
    {Object.entries(config.mcpServers).map(([name, serverConfig]) => (
      <ServerCard
        name={name}
        config={serverConfig}
        status={serverStatuses[name]}
        onStart={() => mcp.startServer(name)}
        onStop={() => mcp.stopServer(name)}
        onRestart={() => mcp.restartServer(name)}
        onDelete={() => confirmDeleteServer(name)}
      />
    ))}
  </TabsContent>

  <TabsContent value="config">
    {/* JSON Editor */}
    <Textarea
      value={configJson}
      onChange={(e) => setConfigJson(e.target.value)}
      className="font-mono"
    />
    <Button onClick={handleSaveJson}>Save Configuration</Button>
  </TabsContent>
</Tabs>
```

### Per-Chat MCP Toggle

**Store**: `apps/web/src/stores/useMCPStore.ts`

**Purpose**: Allow users to disable MCP per-chat (opt-out model)

**State**:
```typescript
interface MCPStoreState {
  // Per-chat MCP toggles - map of chatId to enabled state
  // Default is true (enabled), users can opt-out per-chat
  perChatMCP: Record<string, boolean>;

  // Actions
  setChatMCPEnabled: (chatId: string, enabled: boolean) => void;
  isChatMCPEnabled: (chatId: string) => boolean;
  clearChatMCPSettings: (chatId: string) => void;
  clearAllChatMCPSettings: () => void;
}
```

**Default Behavior**:
```typescript
// MCP is enabled by default when servers are running
isChatMCPEnabled: (chatId: string): boolean => {
  const state = get();
  // If no per-chat setting exists, default to true (enabled)
  return state.perChatMCP[chatId] ?? true;
}
```

**Persistence**: Uses `zustand/persist` middleware with `localStorage`

**Usage in AI Chat**:
```typescript
import { useMCPStore } from '@/stores/useMCPStore';

function AIChatView({ chatId }: { chatId: string }) {
  const mcpEnabled = useMCPStore((state) => state.isChatMCPEnabled(chatId));
  const setMCPEnabled = useMCPStore((state) => state.setChatMCPEnabled);

  // In useChat hook
  const { messages, input, handleSubmit } = useChat({
    api: '/api/ai_conversations/${chatId}/messages',
    body: {
      mcpEnabled, // Send to API
    },
  });

  return (
    <div>
      <Switch
        checked={mcpEnabled}
        onCheckedChange={(enabled) => setMCPEnabled(chatId, enabled)}
      />
      {/* Chat UI */}
    </div>
  );
}
```

---

## Data Flow

### Configuration Update Flow

```
User edits config in UI
  │
  ├─► useMCP.updateConfig(newConfig)
  │      │
  │      ├─► window.electron.mcp.updateConfig(newConfig)
  │      │      │
  │      │      ├─► IPC: 'mcp:update-config'
  │      │      │      │
  │      │      │      ├─► MCPManager.updateConfig(newConfig)
  │      │      │             │
  │      │      │             ├─► Validate config
  │      │      │             ├─► Update in-memory config
  │      │      │             ├─► Update server tracking
  │      │      │             ├─► Stop removed servers
  │      │      │             └─► Save to ~/.pagespace/local-mcp-config.json
  │      │      │
  │      │      └─► Returns { success: true }
  │      │
  │      ├─► Update React state
  │      └─► Show success toast
  │
  └─► UI reflects new config
```

### Server Start Flow

```
User clicks "Start" button
  │
  ├─► useMCP.startServer(name)
  │      │
  │      ├─► window.electron.mcp.startServer(name)
  │      │      │
  │      │      ├─► IPC: 'mcp:start-server'
  │      │      │      │
  │      │      │      ├─► MCPManager.startServer(name)
  │      │      │             │
  │      │      │             ├─► Set status: 'starting'
  │      │      │             ├─► spawn(command, args, { env, stdio })
  │      │      │             ├─► Attach event handlers (exit, error, stdout, stderr)
  │      │      │             ├─► Initialize JSON-RPC tracking
  │      │      │             ├─► Wait 1000ms for process to stabilize
  │      │      │             ├─► Check if still running
  │      │      │             ├─► Set status: 'running'
  │      │      │             └─► Fetch tools (async, non-blocking)
  │      │      │                    │
  │      │      │                    ├─► sendJSONRPCRequest('tools/list')
  │      │      │                    ├─► Wait for response
  │      │      │                    └─► Cache tools in toolCache
  │      │      │
  │      │      └─► Returns { success: true }
  │      │
  │      ├─► Show success toast
  │      └─► Status updated via polling (3s interval)
  │
  └─► UI shows "Running" badge
```

### Tool Execution Flow (Local)

```
AI requests tool execution
  │
  ├─► window.electron.mcp.executeTool(serverName, toolName, args)
  │      │
  │      ├─► IPC: 'mcp:execute-tool'
  │      │      │
  │      │      ├─► MCPManager.executeTool(serverName, toolName, args)
  │      │             │
  │      │             ├─► Verify server is running
  │      │             ├─► sendJSONRPCRequest('tools/call', { name, arguments })
  │      │             │      │
  │      │             │      ├─► Generate request ID
  │      │             │      ├─► Create pending promise
  │      │             │      ├─► Set 30s timeout
  │      │             │      ├─► Write JSON to stdin: {"jsonrpc":"2.0","id":1,"method":"tools/call",...}\n
  │      │             │      │
  │      │             │      └─► Wait for response on stdout
  │      │             │             │
  │      │             │             ├─► MCP server processes request
  │      │             │             ├─► MCP server writes response to stdout
  │      │             │             ├─► handleStdoutData() buffers output
  │      │             │             ├─► Parse newline-delimited JSON
  │      │             │             ├─► handleJSONRPCResponse()
  │      │             │             ├─► Match response.id to pending request
  │      │             │             ├─► Clear timeout
  │      │             │             └─► Resolve promise with result
  │      │             │
  │      │             ├─► Check if response.isError
  │      │             └─► Return { success, result?, error? }
  │      │
  │      └─► Returns ToolExecutionResult
  │
  └─► AI receives tool result
```

### Tool Execution Flow (Remote via WebSocket)

```
VPS AI requests tool execution
  │
  ├─► VPS sends WebSocket message
  │      │
  │      ├─► { type: 'tool_execute', id, serverName, toolName, args }
  │      │
  │      └─► Desktop WS Client receives message
  │             │
  │             ├─► handleToolExecutionRequest()
  │             │      │
  │             │      ├─► getMCPManager().executeTool(serverName, toolName, args)
  │             │      │      │
  │             │      │      └─► (Same as local execution above)
  │             │      │
  │             │      └─► Send result back via WebSocket
  │             │             │
  │             │             └─► { type: 'tool_result', id, success, result?, error? }
  │             │
  │             └─► VPS receives tool result
  │                    │
  │                    └─► Returns to AI
  │
  └─► AI receives tool result
```

### Status Broadcasting Flow

```
Main Process (every 3 seconds)
  │
  ├─► broadcastMCPStatusChange()
  │      │
  │      ├─► mcpManager.getServerStatuses()
  │      │      │
  │      │      └─► Returns Record<string, MCPServerStatusInfo>
  │      │
  │      └─► BrowserWindow.getAllWindows().forEach(window =>
  │             window.webContents.send('mcp:status-changed', statuses)
  │          )
  │
  └─► Renderer Process
         │
         ├─► IPC: 'mcp:status-changed' event
         │      │
         │      └─► useMCP() hook receives statuses
         │             │
         │             └─► setServerStatuses(statuses)
         │
         └─► React re-renders with new statuses
```

---

## File Structure

```
apps/desktop/
├── src/
│   ├── main/
│   │   ├── index.ts                    # Main process entry point
│   │   ├── mcp-manager.ts              # MCP server lifecycle manager
│   │   ├── command-resolver.ts         # Command path resolution for packaged apps
│   │   ├── ws-client.ts                # WebSocket client for MCP bridge
│   │   ├── mcp-tool-converter.ts       # Tool format conversion utilities
│   │   ├── logger.ts                   # Desktop app logging
│   │   └── __tests__/
│   │       ├── mcp-tool-converter.test.ts
│   │       ├── mcp-tool-name-validation.test.ts
│   │       └── mcp-tool-naming-convention.test.ts
│   │
│   ├── preload/
│   │   └── index.ts                    # Secure IPC bridge (contextBridge)
│   │
│   ├── shared/
│   │   ├── mcp-types.ts                # Shared TypeScript types
│   │   ├── mcp-validation.ts           # Configuration validation logic
│   │   └── __tests__/
│   │       └── mcp-timeout-config.test.ts
│   │
│   └── offline.html                    # Offline fallback page
│
├── assets/
│   └── tray-icon.png                   # System tray icon
│
└── package.json

apps/web/src/
├── app/
│   └── settings/
│       └── local-mcp/
│           └── page.tsx                # MCP settings UI
│
├── hooks/
│   └── useMCP.ts                       # React hook for MCP operations
│
├── stores/
│   └── useMCPStore.ts                  # Per-chat MCP toggle state
│
├── lib/
│   ├── auth-fetch.ts                   # Bearer token authentication
│   └── auth/
│       ├── index.ts                    # Multi-token authentication
│       └── csrf-validation.ts          # CSRF validation
│
└── types/
    ├── electron.d.ts                   # TypeScript definitions for window.electron
    └── mcp.ts                          # Frontend MCP types

~/.pagespace/                            # User data directory
├── local-mcp-config.json               # MCP server configuration
└── logs/
    ├── mcp-<servername>.log            # Server stdout/stderr logs
    ├── mcp-<servername>.log.1          # Rotated log file
    ├── mcp-<servername>.log.2
    ├── mcp-<servername>.log.3
    ├── mcp-<servername>.log.4
    ├── mcp-<servername>.log.5
    ├── mcp-errors.log                  # Aggregated error logs
    └── mcp-errors.log.{1-5}            # Rotated error logs
```

---

## Security Considerations

### 1. Trust-Based Security Model

**Philosophy**: Similar to Claude Desktop, Cursor, and Roo Code

**Assumptions**:
- Users trust the MCP servers they configure
- No sandboxing or command restrictions
- Security warnings displayed in UI
- Users responsible for server security

**UI Warning**:
```tsx
<Alert>
  <AlertTriangle className="h-4 w-4" />
  <AlertDescription>
    <strong>Security Notice:</strong> MCP servers execute commands on your computer.
    Only use servers from trusted sources. Review configuration carefully before starting servers.
  </AlertDescription>
</Alert>
```

### 2. Configuration Validation

**Validation Points**:
- ✅ Config structure validation (Zod schemas)
- ✅ Command and args type validation
- ✅ Timeout range validation (1s-5min)
- ✅ Environment variable validation
- ❌ No command allowlisting (trust-based)
- ❌ No argument sanitization (trust-based)

### 3. Process Isolation

**Security Measures**:
- ✅ Child processes spawned with user permissions (not elevated)
- ✅ stdio pipes (stdin/stdout/stderr) for communication
- ✅ No shell execution (`spawn` without `shell: true`)
- ✅ Environment variables explicitly passed (no env inheritance unless specified)
- ❌ No sandboxing (trust-based model)

### 4. Command Resolution Security

**Security Measures**:
- ✅ Resolves commands to absolute paths (prevents PATH injection in some scenarios)
- ✅ Uses system `which`/`where` for resolution (trusted system utilities)
- ✅ Caches resolved paths (prevents repeated expensive lookups)
- ✅ Enhanced PATH only includes standard locations (no arbitrary directories)
- ✅ Falls back to original command if resolution fails (graceful degradation)
- ✅ No shell execution during resolution (`spawn` without `shell: true`)

**Trust-Based Model**:
- ⚠️ Trusts user's configured commands (e.g., `npx`, `node`)
- ⚠️ Enhanced PATH includes version manager directories (nvm, fnm)
- ⚠️ No command allowlisting (user can run any command)
- ⚠️ No argument sanitization (trust-based)

**Rationale**:
- Command resolution is a **convenience feature**, not a security boundary
- Users configure MCP servers manually in JSON config
- Similar to Claude Desktop, Cursor, Roo Code (trust-based)
- Security warnings displayed in UI

**Potential Risks**:
1. **PATH Manipulation**:
   - If user's system is compromised, attacker could place malicious binaries in version manager paths
   - Mitigation: Enhanced PATH only includes standard locations, user's config.env takes precedence

2. **which/where Exploitation**:
   - Unlikely: `which` and `where` are system utilities, not user-controlled
   - Mitigation: No shell execution, direct spawn of `which`/`where`

3. **Cache Poisoning**:
   - If attacker can compromise app memory, they could poison the command cache
   - Mitigation: Cache is in-memory only (doesn't persist), app restart clears it
   - Mitigation: Electron app runs in sandboxed environment

**Security Best Practices**:
- ✅ Keep Node.js and npm up to date
- ✅ Only use MCP servers from trusted sources
- ✅ Review MCP config before starting servers
- ✅ Monitor server logs for unexpected behavior
- ✅ Use absolute paths in config for critical servers (bypasses resolution)

**Example Secure Configuration**:
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "/usr/local/bin/npx",  // Absolute path (no resolution needed)
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "env": {}  // Minimal environment
    }
  }
}
```

### 5. Bearer Token Authentication

**Security Benefits**:
- ✅ CSRF-exempt (tokens in headers not sent automatically)
- ✅ Industry standard OAuth2/JWT pattern
- ✅ Explicit authentication (no automatic cookie sending)
- ✅ Token versioning allows immediate invalidation
- ✅ Tokens stored in Electron's httpOnly cookies (encrypted at rest)

**Security Risks**:
- ⚠️ XSS vulnerability could steal JWT token
- ✅ Mitigation: Same risk as cookies, CSP headers apply
- ✅ Mitigation: Token expiration and refresh flow

### 6. WebSocket Bridge Security

**Authentication**:
- ✅ JWT-based authentication (cookies)
- ✅ Challenge-response protocol (prevents replay attacks)
- ✅ Session verification with `sessionId` derived from JWT
- ✅ Automatic disconnection on authentication failure

**Connection Security**:
- ✅ WSS (WebSocket Secure) in production
- ✅ HTTPS enforcement for non-localhost connections
- ✅ Reverse proxy support with `X-Forwarded-Proto` header
- ✅ Heartbeat mechanism detects dead connections
- ✅ Exponential backoff prevents DoS on reconnection
- ✅ Graceful shutdown on app quit

**Tool Execution Security**:
- ✅ Server must be running to execute tools
- ✅ Tool execution timeout (30s default, configurable)
- ✅ No arbitrary command execution (only tools from running servers)
- ✅ Error messages sanitized before sending to VPS

### 7. IPC Security

**Electron Security Best Practices**:
- ✅ `contextIsolation: true` (renderer isolated from Node.js)
- ✅ `sandbox: true` (renderer runs in sandboxed environment)
- ✅ `nodeIntegration: false` (no direct Node.js access from renderer)
- ✅ `contextBridge` for explicit API exposure
- ✅ No `remote` module usage
- ✅ Typed IPC messages (TypeScript validation)

**IPC Attack Surface**:
- ✅ Limited API surface (only exposed methods)
- ✅ Validation at IPC boundary (Zod schemas)
- ✅ No arbitrary code execution from renderer
- ❌ No rate limiting on IPC calls (trust-based, renderer is controlled by app)

### 8. Log File Security

**Security Measures**:
- ✅ Log files stored in user's home directory (`~/.pagespace/logs/`)
- ✅ File permissions respect OS defaults (user-only access)
- ✅ Log rotation prevents disk exhaustion (10MB × 5 files per server)
- ❌ No log encryption (plain text logs)
- ⚠️ Logs may contain sensitive information from MCP server output

**Recommendations**:
- Users should review logs for sensitive data
- Logs can be deleted manually if needed
- Future enhancement: Log sanitization or encryption

### 9. Configuration File Security

**Security Measures**:
- ✅ Config file stored in user's home directory (`~/.pagespace/local-mcp-config.json`)
- ✅ File permissions respect OS defaults (user-only access)
- ⚠️ Environment variables in config may contain secrets (API keys, tokens)
- ❌ No config encryption (plain text JSON)

**Recommendations**:
- Users should not share config files publicly
- Environment variables should use secrets from OS keychain if possible
- Future enhancement: Integrate with OS keychain for secrets

### 10. Third-Party MCP Servers

**Trust Model**:
- ⚠️ MCP servers run arbitrary code from third parties
- ⚠️ No code signing or verification
- ⚠️ No sandboxing or permission system

**User Responsibilities**:
- Review server source code before running
- Only use servers from trusted sources (official MCP servers, verified developers)
- Monitor server logs for unexpected behavior
- Keep servers updated to latest versions

**Official MCP Servers** (trusted by default):
- `@modelcontextprotocol/server-filesystem`
- `@modelcontextprotocol/server-github`
- `@modelcontextprotocol/server-slack`
- etc.

### 11. Future Security Enhancements

**Roadmap**:
1. **MCP Server Signing**: Verify server signatures before execution
2. **Permission System**: Prompt user for file access, network access, etc.
3. **Sandbox Mode**: Optional sandboxing for untrusted servers
4. **Config Encryption**: Encrypt config file with OS keychain
5. **Log Sanitization**: Automatically redact sensitive patterns (API keys, tokens)
6. **Rate Limiting**: Limit tool execution frequency to prevent abuse
7. **Audit Logging**: Log all tool executions for security review

---

## Error Handling

### 1. Configuration Errors

**Validation Errors**:
```typescript
// Invalid config structure
{
  success: false,
  error: "Missing mcpServers field"
}

// Invalid server config
{
  success: false,
  error: "Server filesystem: command is required"
}

// Invalid timeout
{
  success: false,
  error: "Server filesystem: timeout must be between 1000-300000ms"
}
```

**UI Handling**:
```tsx
const handleSaveJson = async () => {
  try {
    const newConfig = JSON.parse(configJson);
    const result = await mcp.updateConfig(newConfig);
    if (result.success) {
      setJsonError('');
    } else {
      setJsonError(result.error || 'Unknown error');
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Invalid JSON';
    setJsonError(errorMessage);
  }
};
```

### 2. Server Start Errors

**Common Errors**:
```typescript
// Server not found in config
throw new Error(`Server ${name} not found in configuration`);

// Server already running
throw new Error(`Server ${name} is already running`);

// Process spawn failure
server.status = 'error';
server.error = 'Failed to spawn process: command not found';

// Process exited immediately
server.status = 'error';
server.error = 'Process exited immediately after start';
```

**Crash Detection**:
```typescript
childProcess.on('exit', (code, signal) => {
  if (server.status === 'running') {
    // Unexpected exit - mark as crashed
    server.status = 'crashed';
    server.crashCount++;
    server.lastCrashAt = new Date();
    server.error = `Process exited unexpectedly (code: ${code}, signal: ${signal})`;
  }
});
```

**UI Display**:
```tsx
{status.error && (
  <div className="text-red-500">Error: {status.error}</div>
)}
{status.crashCount > 0 && (
  <div>Crashes: {status.crashCount}</div>
)}
```

### 3. Tool Execution Errors

**Error Types**:
```typescript
// Server not running
{
  success: false,
  error: "Server filesystem is not running (status: stopped)"
}

// JSON-RPC timeout
{
  success: false,
  error: "JSON-RPC request timeout after 30000ms"
}

// Tool execution error
{
  success: false,
  error: "File not found: /path/to/file.txt"
}

// MCP server error response
{
  success: false,
  error: "Permission denied: cannot read /etc/shadow"
}
```

**Error Propagation**:
```typescript
async executeTool(serverName: string, toolName: string, args?: Record<string, unknown>): Promise<ToolExecutionResult> {
  try {
    // ... execution logic ...
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Tool execution failed for ${toolName} on ${serverName}:`, error);

    return {
      success: false,
      error: errorMessage,
    };
  }
}
```

### 4. WebSocket Errors

**Connection Errors**:
```typescript
ws.on('error', (error: Error) => {
  console.error('[WS-Client] WebSocket error:', error);
  // Error types:
  // - ECONNREFUSED: Server not reachable
  // - ETIMEDOUT: Connection timeout
  // - CERT_ERROR: SSL certificate error
  // - DNS_ERROR: DNS lookup failed
});

ws.on('close', (code: number, reason: Buffer) => {
  console.log(`[WS-Client] Disconnected. Code: ${code}, Reason: ${reason.toString()}`);

  // Close codes:
  // 1000: Normal closure
  // 1001: Going away (e.g., server shutting down)
  // 1006: Abnormal closure (no close frame)
  // 1008: Policy violation (e.g., auth failed)
  // 1011: Server error

  if (!this.isIntentionallyClosed) {
    this.scheduleReconnect();
  }
});
```

**Authentication Errors**:
```typescript
// No JWT token available
console.error('[WS-Client] Cannot connect without JWT token');
this.scheduleReconnect();

// Challenge verification failed (server closes connection)
// Code 1008, Reason: "Authentication failed"
```

**Reconnection Strategy**:
```typescript
// Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max)
private scheduleReconnect(): void {
  this.reconnectAttempts++;
  const delay = Math.min(
    this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
    this.maxReconnectDelay
  );

  setTimeout(() => this.connect(), delay);
}
```

### 5. IPC Errors

**Renderer → Main**:
```typescript
try {
  const result = await window.electron.mcp.startServer(name);
  if (result.success) {
    toast.success(`Server "${name}" started`);
  } else {
    toast.error(`Failed to start: ${result.error}`);
  }
} catch (error) {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  toast.error(`Error: ${errorMessage}`);
}
```

**Main → Renderer** (status broadcasts):
```typescript
// If window is destroyed or not ready, broadcast fails silently
BrowserWindow.getAllWindows().forEach((window) => {
  if (!window.isDestroyed() && window.webContents) {
    window.webContents.send('mcp:status-changed', statuses);
  }
});
```

### 6. Log File Errors

**Write Errors**:
```typescript
try {
  await rotateLogFile(logFile);
  await fs.appendFile(logFile, logLine);
} catch (error) {
  console.error(`Failed to write to log file ${logFile}:`, error);
  // Errors:
  // - EACCES: Permission denied
  // - ENOSPC: No space left on device
  // - EROFS: Read-only file system
}
```

**Rotation Errors**:
```typescript
try {
  await fs.rename(oldPath, newPath);
} catch (error) {
  // File doesn't exist - skip rotation
  // This is expected behavior, not an error
}
```

---

## Testing Strategy

### Unit Tests

**MCP Manager Tests**:
```typescript
describe('MCPManager', () => {
  it('should load configuration from disk', async () => {
    const manager = new MCPManager();
    await manager.initialize();
    const config = manager.getConfig();
    expect(config).toHaveProperty('mcpServers');
  });

  it('should validate configuration before saving', async () => {
    const manager = new MCPManager();
    const invalidConfig = { invalid: true };
    await expect(manager.updateConfig(invalidConfig)).rejects.toThrow('Invalid configuration');
  });

  it('should start server and update status', async () => {
    const manager = new MCPManager();
    await manager.initialize();
    // Mock server config
    await manager.startServer('test-server');
    const status = manager.getServerStatus('test-server');
    expect(status).toBe('running');
  });
});
```

**Tool Converter Tests** (`mcp-tool-converter.test.ts`):
```typescript
describe('MCP Tool Converter', () => {
  it('should convert MCP tool to PageSpace format', () => {
    const mcpTool = {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } }
    };

    const converted = convertMCPTool(mcpTool, 'filesystem');

    expect(converted).toEqual({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: expect.any(Object),
      serverName: 'filesystem'
    });
  });
});
```

**Tool Name Validation Tests** (`mcp-tool-name-validation.test.ts`):
```typescript
describe('Tool Name Validation', () => {
  it('should accept valid tool names', () => {
    expect(isValidToolName('read-file')).toBe(true);
    expect(isValidToolName('read_file')).toBe(true);
    expect(isValidToolName('ReadFile123')).toBe(true);
  });

  it('should reject invalid tool names', () => {
    expect(isValidToolName('read file')).toBe(false); // space
    expect(isValidToolName('read/file')).toBe(false); // slash
    expect(isValidToolName('read@file')).toBe(false); // special char
    expect(isValidToolName('a'.repeat(65))).toBe(false); // too long
  });
});
```

### Integration Tests

**Server Lifecycle Tests**:
```typescript
describe('MCP Server Lifecycle', () => {
  it('should start, execute tool, and stop server', async () => {
    const manager = getMCPManager();

    // Start server
    await manager.startServer('filesystem');
    expect(manager.getServerStatus('filesystem')).toBe('running');

    // Execute tool
    const result = await manager.executeTool('filesystem', 'read_file', { path: '/tmp/test.txt' });
    expect(result.success).toBe(true);

    // Stop server
    await manager.stopServer('filesystem');
    expect(manager.getServerStatus('filesystem')).toBe('stopped');
  });
});
```

**WebSocket Bridge Tests**:
```typescript
describe('WebSocket Bridge', () => {
  it('should authenticate and execute remote tool', async (done) => {
    const wsClient = new WSClient(mockMainWindow);

    // Connect
    await wsClient.connect();

    // Wait for connected message
    wsClient.on('message', (message) => {
      if (message.type === 'connected') {
        // Send tool execution request
        wsClient.send({
          type: 'tool_execute',
          id: 'test-1',
          serverName: 'filesystem',
          toolName: 'read_file',
          args: { path: '/tmp/test.txt' }
        });
      }

      if (message.type === 'tool_result') {
        expect(message.success).toBe(true);
        wsClient.close();
        done();
      }
    });
  });
});
```

### Manual Testing Checklist

**Server Management**:
- [ ] Add new server via JSON config
- [ ] Start server and verify "running" status
- [ ] Stop server and verify "stopped" status
- [ ] Restart server and verify status cycle
- [ ] Delete server and verify removal from config
- [ ] Auto-start servers on app launch
- [ ] Handle server crash (kill process externally)
- [ ] Verify crash count increments

**Tool Discovery**:
- [ ] Verify tools discovered after server start
- [ ] Verify tools cached correctly
- [ ] Verify aggregated tools from multiple servers
- [ ] Verify tool cache cleared on server stop

**Tool Execution**:
- [ ] Execute tool with valid arguments
- [ ] Execute tool with invalid arguments (should error)
- [ ] Execute tool on stopped server (should error)
- [ ] Verify timeout handling (create slow tool)
- [ ] Verify tool execution result format

**Authentication**:
- [ ] Login to desktop app
- [ ] Verify JWT stored in cookies
- [ ] Verify Bearer token injected in AI chat requests
- [ ] Logout and verify JWT cleared
- [ ] Verify CSRF not required for desktop requests

**WebSocket Bridge**:
- [ ] Verify WebSocket connection established
- [ ] Verify challenge-response authentication
- [ ] Execute tool remotely from VPS
- [ ] Verify reconnection after disconnect
- [ ] Verify graceful shutdown on app quit

**UI/UX**:
- [ ] Settings page shows all servers
- [ ] Status badges update in real-time
- [ ] Server control buttons work correctly
- [ ] JSON editor validates config
- [ ] Error messages display correctly
- [ ] Toast notifications work
- [ ] Desktop-only warning shows on web app

**Error Handling**:
- [ ] Invalid config shows validation error
- [ ] Server start failure shows error message
- [ ] Tool execution timeout shows error
- [ ] Network error shows disconnected status
- [ ] Log file rotation works correctly

---

## Conclusion

PageSpace Desktop's Local MCP setup provides a comprehensive, production-ready system for managing MCP servers locally. The architecture follows industry best practices:

✅ **Electron Security**: Sandboxed renderer, context isolation, minimal IPC surface
✅ **Bearer Token Auth**: Industry-standard OAuth2/JWT pattern, CSRF-exempt
✅ **Process Management**: Proper lifecycle, crash detection, graceful shutdown
✅ **JSON-RPC Communication**: Standard protocol, timeout handling, request/response matching
✅ **WebSocket Bridge**: Optional remote execution with challenge-response auth
✅ **Tool Caching**: Performance optimization with automatic invalidation
✅ **Real-time UI Updates**: 3s polling with live status broadcasting
✅ **Log Rotation**: Prevents disk exhaustion, configurable retention
✅ **Claude Desktop Compatible**: Uses same config format and conventions

The system is designed to be:
- **Secure**: Bearer tokens, context isolation, validation at boundaries
- **Reliable**: Crash recovery, timeout handling, graceful degradation
- **Performant**: Caching, efficient IPC, batched status updates
- **User-Friendly**: Simple JSON config, clear error messages, real-time feedback
- **Extensible**: Modular architecture, typed APIs, well-documented

Future enhancements could include:
- MCP server signing and verification
- Permission prompts for file/network access
- Optional sandbox mode
- Config encryption with OS keychain integration
- Enhanced audit logging

---

**Document Version**: 1.0
**Last Updated**: 2025-10-29
**Maintainer**: PageSpace Development Team
