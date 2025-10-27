import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { app } from 'electron';
import {
  MCPServerConfig,
  MCPConfig,
  MCPServerStatus,
  MCPServerStatusInfo,
  MCP_CONSTANTS,
} from '../shared/mcp-types';
import { validateMCPConfig } from '../shared/mcp-validation';

interface MCPServerProcess {
  config: MCPServerConfig;
  process: ChildProcess | null;
  status: MCPServerStatus;
  error?: string;
  startedAt?: Date;
  crashCount: number;
  lastCrashAt?: Date;
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

      console.log('MCP Manager initialized');
    } catch (error) {
      console.error('Failed to initialize MCP Manager:', error);
      throw error;
    }
  }

  /**
   * Load configuration from disk
   */
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
        // Config file doesn't exist yet - create default
        this.config = { mcpServers: {} };
        await this.saveConfig();
      } else {
        console.error('Failed to load MCP config:', error);
        throw error;
      }
    }
  }

  /**
   * Save configuration to disk
   */
  async saveConfig(): Promise<void> {
    try {
      const configData = JSON.stringify(this.config, null, 2);
      await fs.writeFile(this.configPath, configData, 'utf-8');
    } catch (error) {
      console.error('Failed to save MCP config:', error);
      throw error;
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): MCPConfig {
    return this.config;
  }

  /**
   * Update configuration with validation
   */
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

    await this.saveConfig();
  }

  /**
   * Auto-start servers marked with autoStart: true
   */
  private async autoStartServers(): Promise<void> {
    for (const [name, server] of this.servers.entries()) {
      if (server.config.autoStart && server.config.enabled !== false) {
        try {
          await this.startServer(name);
        } catch (error) {
          console.error(`Failed to auto-start server ${name}:`, error);
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
        console.error(`Server ${name} process error:`, error);
        server.status = 'error';
        server.error = error.message;
        this.logServerError(name, error);
      });

      childProcess.on('exit', (code, signal) => {
        console.log(`Server ${name} exited with code ${code}, signal ${signal}`);

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

      // Capture stdout/stderr for logging
      childProcess.stdout?.on('data', (data) => {
        this.logServerOutput(name, 'stdout', data.toString());
      });

      childProcess.stderr?.on('data', (data) => {
        this.logServerOutput(name, 'stderr', data.toString());
      });

      // Give the process a moment to start
      await new Promise((resolve) => setTimeout(resolve, MCP_CONSTANTS.SERVER_START_DELAY_MS));

      // Check if process is still running
      if (childProcess.exitCode === null && !childProcess.killed) {
        server.status = 'running';
        console.log(`Server ${name} started successfully`);
      } else {
        throw new Error('Process exited immediately after start');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      server.status = 'error';
      server.error = errorMessage;
      server.process = null;
      console.error(`Failed to start server ${name}:`, error);
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
    console.log(`Server ${name} stopped`);
  }

  /**
   * Restart an MCP server
   */
  async restartServer(name: string): Promise<void> {
    await this.stopServer(name);
    await this.startServer(name);
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
    console.log('Shutting down all MCP servers...');
    const stopPromises: Promise<void>[] = [];

    for (const name of this.servers.keys()) {
      stopPromises.push(this.stopServer(name).catch((error) => {
        console.error(`Error stopping server ${name}:`, error);
      }));
    }

    await Promise.all(stopPromises);
    console.log('All MCP servers stopped');
  }

  /**
   * Log server output to file with rotation
   */
  private async logServerOutput(name: string, stream: 'stdout' | 'stderr', data: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${name}] [${stream}] ${data}`;

    const logFile = path.join(this.logDir, `mcp-${name}.log`);

    try {
      // Check if rotation is needed
      await rotateLogFile(logFile);

      // Append log line
      await fs.appendFile(logFile, logLine);
    } catch (error) {
      console.error(`Failed to write to log file ${logFile}:`, error);
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
      console.error('Failed to write error log:', err);
    }
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
