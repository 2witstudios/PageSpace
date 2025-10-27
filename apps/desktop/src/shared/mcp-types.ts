/**
 * Shared type definitions for MCP Server configuration
 * Used across main process, preload, and renderer
 */

/**
 * MCP Server Configuration
 * Matches the format used by Claude Desktop, Cursor, and other MCP clients
 */
export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  autoStart?: boolean;
  enabled?: boolean;
}

/**
 * MCP Configuration File Structure
 */
export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

/**
 * Server Status States
 */
export type MCPServerStatus = 'stopped' | 'starting' | 'running' | 'error' | 'crashed';

/**
 * Extended Server Status Information
 */
export interface MCPServerStatusInfo {
  status: MCPServerStatus;
  error?: string;
  startedAt?: Date;
  crashCount: number;
  lastCrashAt?: Date;
  enabled: boolean;
  autoStart: boolean;
}

/**
 * MCP Tool Definition (for Phase 2)
 */
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  serverName: string;
}

/**
 * Constants for MCP operations
 */
export const MCP_CONSTANTS = {
  SERVER_START_DELAY_MS: 1000,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: 5000,
  STATUS_POLL_INTERVAL_MS: 3000,
  MAX_LOG_FILE_SIZE_BYTES: 10 * 1024 * 1024, // 10MB
  MAX_LOG_FILES: 5,
  TOOL_EXECUTION_TIMEOUT_MS: 30000, // 30 seconds
} as const;
