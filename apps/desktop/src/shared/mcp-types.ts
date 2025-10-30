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
  /**
   * Tool execution timeout in milliseconds
   * If not specified, uses MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS (30000ms)
   * Minimum: 1000ms (1 second)
   * Maximum: 300000ms (5 minutes)
   */
  timeout?: number;
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
 *
 * Tool Naming Convention:
 * - Tool names must match /^[a-zA-Z0-9_-]+$/
 * - Server names must match /^[a-zA-Z0-9_-]+$/
 * - Maximum length: 64 characters
 * - Only alphanumeric characters, hyphens, and underscores allowed
 * - Prevents injection attacks via special characters
 *
 * Namespaced Format: mcp:servername:toolname
 * Example: mcp:my-server:read-file
 * Legacy Format (deprecated): mcp__servername__toolname
 */
export interface MCPTool {
  /**
   * Tool name (validated, alphanumeric + hyphens + underscores only, max 64 chars)
   */
  name: string;

  /**
   * Human-readable description of what the tool does
   */
  description: string;

  /**
   * JSON Schema defining the tool's input parameters
   */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };

  /**
   * MCP server name (validated, alphanumeric + hyphens + underscores only, max 64 chars)
   */
  serverName: string;
}

/**
 * JSON-RPC 2.0 Message Types
 */
export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown> | unknown[];
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JSONRPCError;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * MCP Tool List Response
 */
export interface MCPToolsListResponse {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: {
      type: 'object';
      properties?: Record<string, unknown>;
      required?: string[];
    };
  }>;
}

/**
 * MCP Tool Call Request
 */
export interface MCPToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * MCP Tool Call Response
 */
export interface MCPToolCallResponse {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * Tool Execution Result
 * Simplified format for returning tool execution results
 */
export interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
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
  TOOL_EXECUTION_TIMEOUT_MS: 30000, // 30 seconds (default)
  TOOL_EXECUTION_TIMEOUT_MIN: 1000, // 1 second (minimum allowed)
  TOOL_EXECUTION_TIMEOUT_MAX: 300000, // 5 minutes (maximum allowed)
  JSONRPC_REQUEST_TIMEOUT_MS: 30000, // 30 seconds
  MAX_STDOUT_BUFFER_SIZE_BYTES: 1024 * 1024, // 1MB - prevents memory exhaustion from malformed JSON-RPC output
  STDOUT_BUFFER_WARNING_SIZE_BYTES: 512 * 1024, // 512KB - warn when buffer grows large
} as const;

/**
 * Validates and clamps a timeout value to allowed range
 * @param timeout - Timeout value in milliseconds
 * @returns Clamped timeout value
 */
export function validateTimeout(timeout: number): number {
  return Math.max(
    MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MIN,
    Math.min(timeout, MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MAX)
  );
}

/**
 * Gets the effective timeout for a server configuration
 * Falls back to default if not specified or invalid
 * @param config - MCP server configuration
 * @returns Effective timeout in milliseconds
 */
export function getEffectiveTimeout(config: MCPServerConfig): number {
  if (config.timeout !== undefined && typeof config.timeout === 'number' && config.timeout > 0) {
    return validateTimeout(config.timeout);
  }
  return MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS;
}

/**
 * Gets timeout from environment variable or returns default
 * Environment variable: MCP_TOOL_TIMEOUT_MS
 * @returns Timeout in milliseconds
 */
export function getTimeoutFromEnv(): number {
  const envTimeout = process.env.MCP_TOOL_TIMEOUT_MS;
  if (envTimeout) {
    const parsed = parseInt(envTimeout, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return validateTimeout(parsed);
    }
  }
  return MCP_CONSTANTS.TOOL_EXECUTION_TIMEOUT_MS;
}
