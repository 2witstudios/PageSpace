import WebSocket from 'ws';
import { getMCPManager } from './mcp-manager';
import { logger } from './logger';
import { loadAuthSession } from './auth-storage';

/**
 * WebSocket Client for MCP Bridge
 *
 * Connects desktop app to VPS server, allowing server to execute MCP tools locally.
 *
 * Features:
 * - Opaque session tokens for WebSocket auth (no JWT timing issues)
 * - Heartbeat ping/pong for connection health
 * - Exponential backoff reconnection
 * - Tool execution request handling
 * - Graceful shutdown
 */

interface WebSocketMessage {
  type: string;
  [key: string]: any;
}

interface ToolExecutionRequest {
  type: 'tool_execute';
  id: string;
  serverName: string;
  toolName: string;
  args?: Record<string, unknown>;
}

export class WSClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Infinity; // Always try to reconnect
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 30000; // Max 30 seconds
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isIntentionallyClosed = false;

  constructor() {
    // Session token is obtained from Electron secure storage, no window dependency needed
  }

  /**
   * Get base URL for API requests
   */
  private getBaseUrl(): string {
    let baseUrl =
      process.env.NODE_ENV === 'development'
        ? process.env.PAGESPACE_URL || 'http://localhost:3000'
        : process.env.PAGESPACE_URL || 'https://pagespace.ai';

    // Force HTTPS for non-localhost URLs (security requirement)
    if (!baseUrl.includes('localhost') && !baseUrl.includes('127.0.0.1')) {
      baseUrl = baseUrl.replace(/^http:/, 'https:');
    }

    // Validate the URL is well-formed and uses http(s) protocol
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Invalid protocol: ${parsed.protocol}`);
      }
    } catch (error) {
      logger.error('Invalid base URL configuration', { baseUrl, error });
      return 'https://pagespace.ai';
    }

    return baseUrl;
  }

  /**
   * Get WebSocket URL based on environment
   */
  private getWebSocketUrl(): string {
    // Convert http/https to ws/wss
    return this.getBaseUrl().replace(/^http/, 'ws') + '/api/mcp-ws';
  }

  /**
   * Get session token from Electron secure storage
   * Uses the same token source as Socket.IO for consistency
   */
  private async getSessionToken(): Promise<string | null> {
    try {
      const storedSession = await loadAuthSession();

      if (storedSession?.sessionToken) {
        return storedSession.sessionToken;
      }

      logger.warn('Session token not found in secure storage', {});
      return null;
    } catch (error) {
      logger.error('Error retrieving session token from storage', { error });
      return null;
    }
  }

  /**
   * Get WebSocket session token from server
   * Uses session token to authenticate, receives opaque token for WebSocket connection
   */
  private async getWSToken(): Promise<string | null> {
    try {
      const sessionToken = await this.getSessionToken();
      if (!sessionToken) {
        logger.error('No session token available to get WS token', {});
        return null;
      }

      const baseUrl = this.getBaseUrl();
      const response = await fetch(`${baseUrl}/api/auth/ws-token`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        // Differentiate error types for smarter retry behavior
        if (response.status === 401) {
          logger.error('Session token expired or invalid - need re-authentication', {
            status: response.status,
          });
        } else if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          logger.warn('Rate limited - too many token requests', {
            status: response.status,
            retryAfter,
          });
        } else {
          logger.error('Failed to get WS token', { status: response.status });
        }
        return null;
      }

      const data = (await response.json()) as { token: string };
      return data.token;
    } catch (error) {
      logger.error('Error fetching WS token', { error });
      return null;
    }
  }

  /**
   * Connect to WebSocket server
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.debug('Already connected', {});
      return;
    }

    // Get opaque WebSocket token (authenticated via session token)
    const token = await this.getWSToken();
    if (!token) {
      logger.error('Cannot connect without WS token', {});
      this.scheduleReconnect();
      return;
    }

    const url = this.getWebSocketUrl();
    logger.info('Connecting to server', { url });

    try {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      this.setupEventHandlers();
    } catch (error) {
      logger.error('Connection error', { error });
      this.scheduleReconnect();
    }
  }

  /**
   * Set up WebSocket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      logger.info('Connected to server', {});
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.startHeartbeat();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      logger.info('Disconnected', {
        code,
        reason: reason.toString(),
      });
      this.stopHeartbeat();

      if (!this.isIntentionallyClosed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error: Error) => {
      logger.error('WebSocket error', { error });
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private async handleMessage(data: WebSocket.Data): Promise<void> {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());

      switch (message.type) {
        case 'connected':
          logger.info('Connected and authenticated', { userId: message.userId });
          break;

        case 'pong':
          // Heartbeat response
          break;

        case 'tool_execute':
          await this.handleToolExecutionRequest(
            message as ToolExecutionRequest
          );
          break;

        case 'error':
          logger.error('Server error', { error: message.error });
          break;

        default:
          logger.warn('Unknown message type', { messageType: message.type });
      }
    } catch (error) {
      logger.error('Error parsing message', { error });
    }
  }

  /**
   * Handle tool execution request from server
   */
  private async handleToolExecutionRequest(
    request: ToolExecutionRequest
  ): Promise<void> {
    logger.debug('Tool execution request received', {
      serverName: request.serverName,
      toolName: request.toolName,
    });

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

      logger.debug('Tool execution result', {
        serverName: request.serverName,
        toolName: request.toolName,
        success: result.success,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error('Tool execution error', { error });

      // Send error result back to server
      this.sendMessage({
        type: 'tool_result',
        id: request.id,
        success: false,
        error: errorMessage,
      });
    }
  }

  /**
   * Send message to server
   */
  private sendMessage(message: WebSocketMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error('Cannot send message - not connected', {});
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      logger.error('Error sending message', { error });
    }
  }

  /**
   * Start heartbeat ping/pong
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      this.sendMessage({ type: 'ping', timestamp: Date.now() });
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.isIntentionallyClosed) return;

    // Clear any existing reconnect timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    logger.info('Scheduling reconnection', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delayMs: delay,
    });

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Get connection status
   */
  getStatus(): {
    connected: boolean;
    reconnectAttempts: number;
  } {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Close connection gracefully
   */
  close(): void {
    logger.info('Closing connection gracefully', {});
    this.isIntentionallyClosed = true;

    this.stopHeartbeat();

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'App closing');
      this.ws = null;
    }
  }
}

// Singleton instance
let wsClient: WSClient | null = null;

/**
 * Initialize WebSocket client
 */
export function initializeWSClient(): void {
  if (wsClient) {
    logger.warn('Already initialized', {});
    return;
  }

  wsClient = new WSClient();

  // Give the app a moment to load and establish auth session
  setTimeout(() => {
    wsClient?.connect();
  }, 2000);
}

/**
 * Get WebSocket client instance
 */
export function getWSClient(): WSClient | null {
  return wsClient;
}

/**
 * Shutdown WebSocket client
 */
export function shutdownWSClient(): void {
  if (wsClient) {
    wsClient.close();
    wsClient = null;
  }
}
