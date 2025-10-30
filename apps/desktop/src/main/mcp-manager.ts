import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { resolveCommand, getEnhancedEnvironment } from './command-resolver';
import {
  MCPServerConfig,
  MCPConfig,
  MCPServerStatus,
  MCPServerStatusInfo,
  MCP_CONSTANTS,
  JSONRPCRequest,
  JSONRPCResponse,
  MCPTool,
  MCPToolsListResponse,
  MCPToolCallRequest,
  MCPToolCallResponse,
  ToolExecutionResult,
} from '../shared/mcp-types';
import { validateMCPConfig } from '../shared/mcp-validation';
import { logger } from './logger';

interface MCPServerProcess {
  config: MCPServerConfig;
  process: ChildProcess | null;
  status: MCPServerStatus;
  error?: string;
  startedAt?: Date;
  crashCount: number;
  lastCrashAt?: Date;
}

interface PendingJSONRPCRequest {
  resolve: (value: JSONRPCResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

/**
 * Log rotation helper
 */
async function rotateLogFile(logPath: string): Promise<void> {
  try {
    const stats = await fs.stat(logPath);
    if (stats.size > MCP_CONSTANTS.MAX_LOG_FILE_SIZE_BYTES) {
      // Rotate logs
      for (let i = MCP_CONSTANTS.MAX_LOG_FILES - 1; i > 0; i--) {
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
    // Log file doesn't exist yet or error checking size
  }
}

/**
 * MCPManager - Manages local MCP server processes for PageSpace Desktop
 *
 * Responsibilities:
 * - Load/save MCP configuration from ~/.pagespace/local-mcp-config.json
 * - Spawn and manage MCP server child processes
 * - Monitor server health and handle crashes
 * - Provide status information to renderer process
 *
 * Security Model: Trust-based (like Claude Desktop)
 * - Users can run any npx command or local script
 * - No sandboxing or command restrictions
 * - Security warnings displayed in UI
 */
export class MCPManager {
  private config: MCPConfig = { mcpServers: {} };
  private servers: Map<string, MCPServerProcess> = new Map();
  private configPath: string;
  private logDir: string;

  // JSON-RPC communication tracking
  private pendingRequests: Map<string, Map<string | number, PendingJSONRPCRequest>> = new Map();
  private nextRequestId = 1;
  private stdoutBuffers: Map<string, string> = new Map();

  // Tool discovery and caching
  private toolCache: Map<string, MCPTool[]> = new Map();

  // Log rate limiting and batching (Issue #2)
  private lastRotationCheck: Map<string, number> = new Map();
  private logWriteBuffer: Map<string, string[]> = new Map();
  private logFlushTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly ROTATION_CHECK_INTERVAL_MS = 60000; // 60 seconds
  private readonly LOG_FLUSH_INTERVAL_MS = 1000; // 1 second
  private readonly LOG_BUFFER_MAX_SIZE = 100; // Flush after 100 lines

  constructor() {
    const userDataPath = app.getPath('userData');
    this.configPath = path.join(userDataPath, 'local-mcp-config.json');
    this.logDir = path.join(userDataPath, 'logs');
  }

  /**
   * Initialize the MCP manager
   * - Creates config directory if needed
   * - Loads existing configuration
   * - Auto-starts enabled servers
   */
  async initialize(): Promise<void> {
    try {
      // Ensure directories exist
      await fs.mkdir(path.dirname(this.configPath), { recursive: true });
      await fs.mkdir(this.logDir, { recursive: true });

      // Load configuration
      await this.loadConfig();

      // Auto-start enabled servers
      await this.autoStartServers();

      logger.info('MCP Manager initialized', { configPath: this.configPath });
    } catch (error) {
      logger.error('Failed to initialize MCP Manager', { error });
      throw error;
    }
  }

  /**
   * Load configuration from disk
   */
  private async loadConfig(): Promise<void> {
    logger.debug('loadConfig called', { configPath: this.configPath });

    try {
      const configData = await fs.readFile(this.configPath, 'utf-8');
      logger.debug('Raw config data read from disk', { sizeBytes: configData.length });

      this.config = JSON.parse(configData);
      logger.debug('Parsed config', { serverCount: Object.keys(this.config.mcpServers).length });

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

      logger.info('Config loaded successfully', { serverCount: Object.keys(this.config.mcpServers).length });
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // Config file doesn't exist yet - create default
        logger.info('Config file does not exist, creating default empty config', { configPath: this.configPath });
        this.config = { mcpServers: {} };
        await this.saveConfig();
      } else {
        logger.error('Failed to load MCP config', { error, configPath: this.configPath });
        logger.error('Error details', { errorCode: error.code, errorMessage: error.message });
        throw error;
      }
    }
  }

  /**
   * Save configuration to disk
   */
  async saveConfig(): Promise<void> {
    logger.debug('saveConfig called', {});
    logger.debug('Config file path', { configPath: this.configPath });
    logger.debug('Config to save', { config: this.config });

    try {
      const configData = JSON.stringify(this.config, null, 2);
      logger.debug('Stringified config data', { dataLength: configData.length });

      await fs.writeFile(this.configPath, configData, 'utf-8');
      logger.info('Config successfully written to disk', { configPath: this.configPath });

      // Verify the write by reading it back
      const verification = await fs.readFile(this.configPath, 'utf-8');
      logger.debug('Verification read', { verificationLength: verification.length });
    } catch (error) {
      logger.error('Failed to save MCP config', { error, configPath: this.configPath });
      logger.error('Error details', { errorMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): MCPConfig {
    logger.debug('getConfig called', {});
    logger.debug('Returning in-memory config', { config: this.config });
    logger.debug('Server count', { serverCount: Object.keys(this.config.mcpServers).length });

    // Return deep clone to prevent external mutations of internal state
    return JSON.parse(JSON.stringify(this.config));
  }

  /**
   * Update configuration with validation
   */
  async updateConfig(newConfig: MCPConfig): Promise<void> {
    logger.debug('updateConfig called', {});
    logger.debug('New config', { newConfig });

    // Validate configuration
    const validation = validateMCPConfig(newConfig);
    if (!validation.success) {
      logger.error('Validation failed', { validationError: validation.error });
      throw new Error(`Invalid configuration: ${validation.error}`);
    }

    logger.debug('Validation passed, updating config', {});
    this.config = validation.data;

    // Update server process tracking
    for (const [name, serverConfig] of Object.entries(newConfig.mcpServers)) {
      if (!this.servers.has(name)) {
        this.servers.set(name, {
          config: serverConfig,
          process: null,
          status: 'stopped',
          crashCount: 0,
        });
      } else {
        // Update config for existing server
        const server = this.servers.get(name)!;
        server.config = serverConfig;
      }
    }

    // Remove servers that are no longer in config
    const configNames = new Set(Object.keys(newConfig.mcpServers));
    for (const name of this.servers.keys()) {
      if (!configNames.has(name)) {
        await this.stopServer(name);
        this.servers.delete(name);
      }
    }

    logger.debug('Saving config to disk', {});
    await this.saveConfig();
    logger.info('Config saved successfully', {});
  }

  /**
   * Auto-start servers on app launch (unless autoStart: false)
   * Defaults to auto-start if autoStart field is not specified
   */
  private async autoStartServers(): Promise<void> {
    for (const [name, server] of this.servers.entries()) {
      if (server.config.autoStart !== false && server.config.enabled !== false) {
        try {
          logger.info('Auto-starting server', { serverName: name });
          await this.startServer(name);
        } catch (error) {
          logger.error('Failed to auto-start server', { serverName: name, error });
        }
      }
    }
  }

  /**
   * Start an MCP server
   */
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
      // Resolve command path (critical for packaged apps where PATH is minimal)
      const resolvedCommand = await resolveCommand(config.command);
      logger.debug('Resolved command', { command: config.command, resolvedCommand });

      // Construct enhanced environment with Node.js paths
      const enhancedEnv = getEnhancedEnvironment();

      // Spawn the MCP server process with enhanced environment
      const childProcess = spawn(resolvedCommand, config.args, {
        env: { ...enhancedEnv, ...config.env }, // User config.env takes precedence
        stdio: ['pipe', 'pipe', 'pipe'], // stdin, stdout, stderr
      });

      server.process = childProcess;
      server.startedAt = new Date();
      server.error = undefined;

      // Set up event handlers
      childProcess.on('error', (error) => {
        logger.error('Server process error', { serverName: name, error });
        server.status = 'error';
        server.error = error.message;
        this.logServerError(name, error);
      });

      childProcess.on('exit', (code, signal) => {
        logger.info('Server exited', { serverName: name, exitCode: code, signal });

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

      // Initialize JSON-RPC tracking for this server
      if (!this.pendingRequests.has(name)) {
        this.pendingRequests.set(name, new Map());
      }
      if (!this.stdoutBuffers.has(name)) {
        this.stdoutBuffers.set(name, '');
      }

      // Capture stdout for JSON-RPC responses
      childProcess.stdout?.on('data', (data) => {
        const output = data.toString();
        this.logServerOutput(name, 'stdout', output);
        this.handleStdoutData(name, output);
      });

      childProcess.stderr?.on('data', (data) => {
        this.logServerOutput(name, 'stderr', data.toString());
      });

      // Give the process a moment to start
      await new Promise((resolve) => setTimeout(resolve, MCP_CONSTANTS.SERVER_START_DELAY_MS));

      // Check if process is still running
      if (childProcess.exitCode === null && !childProcess.killed) {
        server.status = 'running';
        logger.info('Server started successfully', { serverName: name });

        // Fetch tools from server (async, don't wait for completion)
        this.getMCPTools(name).catch((error) => {
          logger.error('Failed to fetch tools after startup', { serverName: name, error });
        });
      } else {
        throw new Error('Process exited immediately after start');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      server.status = 'error';
      server.error = errorMessage;
      server.process = null;
      logger.error('Failed to start server', { serverName: name, error });
      this.logServerError(name, error instanceof Error ? error : new Error(errorMessage));
      throw error;
    }
  }

  /**
   * Stop an MCP server
   */
  async stopServer(name: string): Promise<void> {
    const server = this.servers.get(name);
    if (!server) {
      throw new Error(`Server ${name} not found`);
    }

    if (!server.process) {
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

    // Clear stdout buffer
    this.stdoutBuffers.set(name, '');

    // Clear tool cache
    this.clearToolCache(name);

    // Issue #3: Clear overflow and logging state to prevent memory leak
    // Flush any pending log buffers before clearing
    const stdoutKey = `${name}:stdout`;
    const stderrKey = `${name}:stderr`;

    await Promise.all([
      this.flushLogBuffer(name, 'stdout').catch(() => {
        /* ignore flush errors on shutdown */
      }),
      this.flushLogBuffer(name, 'stderr').catch(() => {
        /* ignore flush errors on shutdown */
      }),
    ]);

    // Clear log buffers and timers
    this.logWriteBuffer.delete(stdoutKey);
    this.logWriteBuffer.delete(stderrKey);

    [stdoutKey, stderrKey].forEach((key) => {
      const timer = this.logFlushTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.logFlushTimers.delete(key);
      }
    });

    // Clear rotation check timestamp for this server's log file
    const logFile = path.join(this.logDir, `mcp-${name}.log`);
    this.lastRotationCheck.delete(logFile);

    // Kill the process
    server.process.kill('SIGTERM');

    // Wait for process to exit (with timeout)
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if not exited
        if (server.process) {
          server.process.kill('SIGKILL');
        }
        resolve();
      }, MCP_CONSTANTS.GRACEFUL_SHUTDOWN_TIMEOUT_MS);

      server.process!.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    server.process = null;
    logger.info('Server stopped', { serverName: name });
  }

  /**
   * Restart an MCP server
   */
  async restartServer(name: string): Promise<void> {
    await this.stopServer(name);
    await this.startServer(name);
    // Tool cache will be automatically refreshed by startServer's getMCPTools call
  }

  /**
   * Get status of all servers
   */
  getServerStatuses(): Record<string, MCPServerStatusInfo> {
    const statuses: Record<string, MCPServerStatusInfo> = {};

    for (const [name, server] of this.servers.entries()) {
      statuses[name] = {
        status: server.status,
        error: server.error,
        startedAt: server.startedAt,
        crashCount: server.crashCount,
        lastCrashAt: server.lastCrashAt,
        enabled: server.config.enabled !== false,
        autoStart: server.config.autoStart || false,
      };
    }

    return statuses;
  }

  /**
   * Get status of a specific server
   */
  getServerStatus(name: string): MCPServerStatus | null {
    const server = this.servers.get(name);
    return server ? server.status : null;
  }

  /**
   * Shutdown all servers (called on app quit)
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down all MCP servers', {});
    const stopPromises: Promise<void>[] = [];

    for (const name of this.servers.keys()) {
      stopPromises.push(this.stopServer(name).catch((error) => {
        logger.error('Error stopping server', { serverName: name, error });
      }));
    }

    await Promise.all(stopPromises);
    logger.info('All MCP servers stopped', {});
  }

  /**
   * Log server output to file with rotation (Issue #2: Rate-limited & batched)
   */
  private logServerOutput(name: string, stream: 'stdout' | 'stderr', data: string): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${name}] [${stream}] ${data}`;
    const logKey = `${name}:${stream}`;

    // Add to buffer
    if (!this.logWriteBuffer.has(logKey)) {
      this.logWriteBuffer.set(logKey, []);
    }
    this.logWriteBuffer.get(logKey)!.push(logLine);

    // Flush immediately if buffer is full (prevents memory bloat)
    if (this.logWriteBuffer.get(logKey)!.length >= this.LOG_BUFFER_MAX_SIZE) {
      this.flushLogBuffer(name, stream).catch((error) => {
        logger.error('Failed to flush log buffer (full)', { name, stream, error });
      });
    } else {
      // Schedule flush if not already scheduled
      if (!this.logFlushTimers.has(logKey)) {
        const timer = setTimeout(() => {
          this.flushLogBuffer(name, stream).catch((error) => {
            logger.error('Failed to flush log buffer (timer)', { name, stream, error });
          });
        }, this.LOG_FLUSH_INTERVAL_MS);
        this.logFlushTimers.set(logKey, timer);
      }
    }
  }

  /**
   * Flush buffered logs to disk (Issue #2: Rate-limited rotation checks)
   */
  private async flushLogBuffer(name: string, stream: 'stdout' | 'stderr'): Promise<void> {
    const logKey = `${name}:${stream}`;
    const buffer = this.logWriteBuffer.get(logKey);

    if (!buffer || buffer.length === 0) return;

    // Clear timer
    const timer = this.logFlushTimers.get(logKey);
    if (timer) {
      clearTimeout(timer);
      this.logFlushTimers.delete(logKey);
    }

    // Get all buffered lines
    const lines = buffer.splice(0, buffer.length);
    const logFile = path.join(this.logDir, `mcp-${name}.log`);

    try {
      // Rate-limited rotation check (max once per 60 seconds per file)
      const now = Date.now();
      const lastCheck = this.lastRotationCheck.get(logFile) || 0;

      if (now - lastCheck > this.ROTATION_CHECK_INTERVAL_MS) {
        await rotateLogFile(logFile);
        this.lastRotationCheck.set(logFile, now);
      }

      // Write all buffered lines at once (reduces I/O operations)
      await fs.appendFile(logFile, lines.join('\n') + '\n');
    } catch (error) {
      logger.error('Failed to write to log file', { logFile, error });
    }
  }

  /**
   * Log server error to file with rotation
   */
  private async logServerError(name: string, error: Error): Promise<void> {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${name}] [ERROR] ${error.message}\n${error.stack}\n`;

    const errorLogFile = path.join(this.logDir, 'mcp-errors.log');

    try {
      // Check if rotation is needed
      await rotateLogFile(errorLogFile);

      // Append error log
      await fs.appendFile(errorLogFile, logLine);
    } catch (err) {
      logger.error('Failed to write error log', { error: err });
    }
  }

  /**
   * Handle stdout data and parse JSON-RPC responses
   */
  private handleStdoutData(serverName: string, data: string): void {
    // Append to buffer
    const currentBuffer = this.stdoutBuffers.get(serverName) || '';
    const newBuffer = currentBuffer + data;

    // SECURITY: Prevent unbounded memory growth from malformed output
    // If buffer exceeds maximum size, parse valid messages BEFORE clearing (Issue #1)
    if (newBuffer.length > MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES) {
      logger.error('stdout buffer overflow - attempting to parse valid messages before clearing', {
        serverName,
        bufferSize: newBuffer.length,
        maxSize: MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES,
      });

      // CRITICAL FIX (Issue #1): Extract and parse any valid JSON-RPC messages BEFORE clearing
      const lines = newBuffer.split('\n');
      const incompleteLineIndex = newBuffer.endsWith('\n') ? lines.length : lines.length - 1;

      let parsedCount = 0;
      let failedCount = 0;

      for (let i = 0; i < incompleteLineIndex; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        try {
          const message = JSON.parse(line) as JSONRPCResponse;
          this.handleJSONRPCResponse(serverName, message);
          parsedCount++;
        } catch (error) {
          // Invalid JSON, skip this line
          failedCount++;
        }
      }

      logger.info('Buffer overflow recovery complete', {
        serverName,
        parsedMessages: parsedCount,
        failedLines: failedCount,
        totalLines: incompleteLineIndex,
      });

      // Now clear the buffer
      this.stdoutBuffers.set(serverName, '');

      // Log the error to file for diagnostics
      this.logServerError(
        serverName,
        new Error(
          `stdout buffer overflow (${newBuffer.length} bytes). ` +
          `Parsed ${parsedCount} valid messages before clearing. ` +
          `Server may not be sending newline-delimited JSON-RPC responses.`
        )
      );
      return;
    }

    // Warn when buffer grows large (early warning before overflow)
    if (
      newBuffer.length > MCP_CONSTANTS.STDOUT_BUFFER_WARNING_SIZE_BYTES &&
      currentBuffer.length <= MCP_CONSTANTS.STDOUT_BUFFER_WARNING_SIZE_BYTES
    ) {
      logger.warn('stdout buffer growing large', {
        serverName,
        bufferSize: newBuffer.length,
        warningThreshold: MCP_CONSTANTS.STDOUT_BUFFER_WARNING_SIZE_BYTES,
        maxThreshold: MCP_CONSTANTS.MAX_STDOUT_BUFFER_SIZE_BYTES,
      });
    }

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
        logger.warn('Failed to parse JSON-RPC message', { serverName, line, error });
      }
    }
  }

  /**
   * Handle a parsed JSON-RPC response
   */
  private handleJSONRPCResponse(serverName: string, response: JSONRPCResponse): void {
    const pendingMap = this.pendingRequests.get(serverName);
    if (!pendingMap) return;

    const pending = pendingMap.get(response.id);
    if (!pending) {
      logger.warn('Unknown response ID', { serverName, responseId: response.id });
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

  /**
   * Send a JSON-RPC request to a server and wait for response
   */
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

    // Create promise that will be resolved when response arrives
    return new Promise<JSONRPCResponse>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        const pendingMap = this.pendingRequests.get(serverName);
        if (pendingMap) {
          pendingMap.delete(requestId);
        }
        reject(new Error(`JSON-RPC request timeout after ${MCP_CONSTANTS.JSONRPC_REQUEST_TIMEOUT_MS}ms`));
      }, MCP_CONSTANTS.JSONRPC_REQUEST_TIMEOUT_MS);

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

  /**
   * Wait for a specific JSON-RPC response by ID
   * This is an alternative approach if you want to manually manage request/response matching
   */
  async waitForJSONRPCResponse(
    serverName: string,
    requestId: string | number,
    timeoutMs: number = MCP_CONSTANTS.JSONRPC_REQUEST_TIMEOUT_MS
  ): Promise<JSONRPCResponse> {
    return new Promise<JSONRPCResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pendingMap = this.pendingRequests.get(serverName);
        if (pendingMap) {
          pendingMap.delete(requestId);
        }
        reject(new Error(`JSON-RPC response timeout for request ${requestId}`));
      }, timeoutMs);

      const pendingMap = this.pendingRequests.get(serverName);
      if (!pendingMap) {
        clearTimeout(timeout);
        reject(new Error(`Server ${serverName} has no pending requests map`));
        return;
      }

      pendingMap.set(requestId, { resolve, reject, timeout });
    });
  }

  /**
   * Fetch tools from a specific MCP server and cache them
   * Called automatically after server starts
   */
  async getMCPTools(serverName: string): Promise<MCPTool[]> {
    try {
      logger.debug('Fetching tools from server', { serverName });

      // Send tools/list request
      const response = await this.sendJSONRPCRequest(serverName, 'tools/list', {});

      if (!response.result) {
        logger.warn('No result in tools/list response', { serverName });
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

      logger.info('Cached tools from server', { serverName, toolCount: tools.length });
      return tools;
    } catch (error) {
      logger.error('Failed to fetch tools', { serverName, error });
      // Cache empty array on error
      this.toolCache.set(serverName, []);
      return [];
    }
  }

  /**
   * Refresh tool cache for a specific server
   * Called when server restarts
   */
  async refreshToolCache(serverName: string): Promise<void> {
    logger.debug('Refreshing tool cache', { serverName });

    // Invalidate existing cache
    this.toolCache.delete(serverName);

    // Fetch fresh tools
    await this.getMCPTools(serverName);
  }

  /**
   * Get aggregated tools from all enabled and running servers
   */
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

  /**
   * Get tools from a specific server (from cache)
   */
  getServerTools(serverName: string): MCPTool[] {
    return this.toolCache.get(serverName) || [];
  }

  /**
   * Clear tool cache for a specific server
   */
  clearToolCache(serverName: string): void {
    this.toolCache.delete(serverName);
  }

  /**
   * Clear all tool caches
   */
  clearAllToolCaches(): void {
    this.toolCache.clear();
  }

  /**
   * Execute a tool on a specific MCP server
   * @param serverName The name of the server to execute the tool on
   * @param toolName The name of the tool to execute
   * @param args The arguments to pass to the tool
   * @returns ToolExecutionResult with success/error information
   */
  async executeTool(
    serverName: string,
    toolName: string,
    args?: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    try {
      logger.debug('Executing tool', { serverName, toolName, args });

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
      logger.error('Tool execution failed', { serverName, toolName, error });

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Execute a tool by full tool name (format: mcp_servername_toolname)
   * Parses the server name from the tool name and executes
   */
  async executeToolByFullName(
    fullToolName: string,
    args?: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    // Parse tool name format: mcp_servername_toolname
    const match = fullToolName.match(/^mcp_([^_]+)_(.+)$/);

    if (!match) {
      return {
        success: false,
        error: `Invalid tool name format: ${fullToolName}. Expected format: mcp_servername_toolname`,
      };
    }

    const [, serverName, toolName] = match;
    return this.executeTool(serverName, toolName, args);
  }
}

// Singleton instance
let mcpManager: MCPManager | null = null;

/**
 * Get the MCP manager singleton
 */
export function getMCPManager(): MCPManager {
  if (!mcpManager) {
    mcpManager = new MCPManager();
  }
  return mcpManager;
}
