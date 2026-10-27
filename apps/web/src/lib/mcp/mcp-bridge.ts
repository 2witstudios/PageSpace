import { getConnection, checkConnectionHealth } from '@/lib/websocket';
import { logger } from '@pagespace/lib/logging/logger';
import { RequestCorrelator, CorrelationError } from '@/lib/env-bridge/correlator';

/**
 * MCP Bridge - Server-side WebSocket manager for tool execution
 *
 * This class manages the communication between the Next.js server and desktop
 * clients for executing MCP tools locally on the user's machine.
 *
 * Features:
 * - Tool execution request/response matching (the shared `RequestCorrelator`;
 *   this bridge keeps its 30s default, the env bridge takes its deadlines from
 *   `resolveTimeout`)
 * - Timeout handling (30s default)
 * - Connection status checking
 * - Error handling and logging
 */

interface ToolExecutionRequest {
  type: 'tool_execute';
  id: string;
  serverName: string;
  toolName: string;
  args?: Record<string, unknown>;
}

interface ToolExecutionResponse {
  type: 'tool_result';
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export class MCPBridge {
  private readonly defaultTimeout = 30000; // 30 seconds
  private readonly logger = logger.child({ component: 'mcp-bridge' });
  private readonly correlator = new RequestCorrelator<unknown>();

  /**
   * Execute a tool on the user's desktop via WebSocket
   *
   * @param userId - The user ID whose desktop will execute the tool
   * @param serverName - The MCP server name
   * @param toolName - The tool name to execute
   * @param args - Arguments to pass to the tool
   * @returns Promise that resolves with the tool execution result
   */
  async executeTool(
    userId: string,
    serverName: string,
    toolName: string,
    args?: Record<string, unknown>
  ): Promise<unknown> {
    // Check if user has an active WebSocket connection
    const connection = getConnection(userId);

    if (!connection || connection.readyState !== 1) {
      // WebSocket.OPEN === 1
      throw new Error(
        'Desktop app not connected. Please ensure PageSpace Desktop is running and connected.'
      );
    }

    // Defense-in-depth: Verify connection is healthy and challenge-verified
    // Prevents sending tool arguments to unverified connections (info disclosure)
    const health = checkConnectionHealth(connection);
    if (!health.isHealthy) {
      throw new Error(
        `Desktop connection unhealthy: ${health.reason}. Please reconnect PageSpace Desktop.`
      );
    }

    // Generate unique request ID
    const requestId = crypto.randomUUID();

    // Create the tool execution request
    const request: ToolExecutionRequest = {
      type: 'tool_execute',
      id: requestId,
      serverName,
      toolName,
      args,
    };

    this.logger.info('Sending tool execution request to desktop', {
      userId,
      serverName,
      toolName,
      requestId,
      action: 'send_tool_request',
    });

    // The correlator registers the id, arms the 30s deadline and puts the
    // request on the wire; its typed failures are mapped back to this bridge's
    // historical error messages so callers see exactly what they always did.
    return this.correlator
      .open({
        id: requestId,
        group: userId,
        timeoutMs: this.defaultTimeout,
        send: () => connection.send(JSON.stringify(request)),
      })
      .catch((error: unknown) => {
        if (error instanceof CorrelationError && error.kind === 'timeout') {
          throw new Error(`Tool execution timeout after ${this.defaultTimeout}ms: ${serverName}.${toolName}`);
        }
        if (error instanceof CorrelationError && error.kind === 'send_failed') {
          throw new Error(`Failed to send tool execution request: ${error.message.replace(/^Failed to send request: /, '')}`);
        }
        throw error;
      });
  }

  /**
   * Handle a tool execution response from the desktop client
   *
   * This should be called from the WebSocket route handler when a
   * tool_result message is received.
   *
   * @param response - The tool execution response from the desktop
   */
  handleToolResponse(response: ToolExecutionResponse): void {
    if (!this.correlator.has(response.id)) {
      this.logger.warn('Received response for unknown request ID', {
        requestId: response.id,
        action: 'handle_tool_response',
        status: 'unknown_request',
      });
      return;
    }

    // Resolve or reject the promise (the correlator clears the deadline and forgets the id)
    if (response.success) {
      this.logger.info('Tool execution succeeded', {
        requestId: response.id,
        action: 'handle_tool_response',
        status: 'success',
      });
      this.correlator.resolve(response.id, response.result);
    } else {
      this.logger.error('Tool execution failed', {
        requestId: response.id,
        error: response.error,
        action: 'handle_tool_response',
        status: 'failed',
      });
      this.correlator.reject(
        response.id,
        new Error(response.error || 'Tool execution failed with unknown error')
      );
    }
  }

  /**
   * Cancel all pending requests for a user (e.g., when they disconnect)
   *
   * @param userId - The user ID whose requests should be cancelled
   */
  cancelUserRequests(userId: string): void {
    // Note: In a real implementation, you might want to track which requests
    // belong to which user. For simplicity, we'll just note this in the logs.
    this.logger.info('User disconnected, pending requests will timeout', {
      userId,
      pendingCount: this.correlator.pendingCount(),
      action: 'cancel_user_requests',
    });
  }

  /**
   * Check if a user has an active desktop connection
   *
   * @param userId - The user ID to check
   * @returns true if the user has an active WebSocket connection
   */
  isUserConnected(userId: string): boolean {
    const connection = getConnection(userId);
    return connection !== undefined && connection.readyState === 1; // WebSocket.OPEN
  }

  /**
   * Get the number of pending requests
   */
  getPendingRequestCount(): number {
    return this.correlator.pendingCount();
  }
}

// Singleton instance
let mcpBridge: MCPBridge | null = null;

/**
 * Get the MCP bridge singleton
 */
export function getMCPBridge(): MCPBridge {
  if (!mcpBridge) {
    mcpBridge = new MCPBridge();
  }
  return mcpBridge;
}
