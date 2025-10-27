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
}
