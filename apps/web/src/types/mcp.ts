/**
 * MCP Type definitions for web package
 * Mirrors types from desktop package
 */

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  autoStart?: boolean;
  enabled?: boolean;
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export type MCPServerStatus = 'stopped' | 'starting' | 'running' | 'error' | 'crashed';

export interface MCPServerStatusInfo {
  status: MCPServerStatus;
  error?: string;
  startedAt?: Date;
  crashCount: number;
  lastCrashAt?: Date;
  enabled: boolean;
  autoStart: boolean;
  /**
   * Whether tools have been fetched and cached for this server.
   * A server can be 'running' but not have tools ready yet (during initialization).
   * Only consider tools "available" when BOTH status === 'running' AND toolsReady === true.
   */
  toolsReady?: boolean;
}

/**
 * MCP Tool Definition
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
 * Tool Execution Result
 */
export interface ToolExecutionResult {
  success: boolean;
  result?: unknown;
  error?: string;
}
