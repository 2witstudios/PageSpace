import WebSocket from 'ws';
import { BrowserWindow } from 'electron';
import { getMCPManager } from './mcp-manager';
import crypto from 'crypto';

/**
 * WebSocket Client for MCP Bridge
 *
 * Connects desktop app to VPS server, allowing server to execute MCP tools locally.
 *
 * Features:
 * - Automatic JWT extraction from browser cookies
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
  private mainWindow: BrowserWindow | null = null;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  /**
   * Get WebSocket URL based on environment
   */
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

  /**
   * Extract JWT token from browser cookies
   */
  private async getJWTToken(): Promise<string | null> {
    if (!this.mainWindow) {
      console.error('[WS-Client] Main window not available');
      return null;
    }

    try {
      const cookies = await this.mainWindow.webContents.session.cookies.get({
        name: 'accessToken',
      });

      if (cookies.length > 0) {
        return cookies[0].value;
      }

      console.warn('[WS-Client] JWT token not found in cookies');
      return null;
    } catch (error) {
      console.error('[WS-Client] Error extracting JWT token:', error);
      return null;
    }
  }

  /**
   * Connect to WebSocket server
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log('[WS-Client] Already connected');
      return;
    }

    // Get JWT token
    const token = await this.getJWTToken();
    if (!token) {
      console.error('[WS-Client] Cannot connect without JWT token');
      // Retry after delay
      this.scheduleReconnect();
      return;
    }

    const url = this.getWebSocketUrl();
    console.log(`[WS-Client] Connecting to ${url}...`);

    try {
      this.ws = new WebSocket(url, {
        headers: {
          Cookie: `accessToken=${token}`,
        },
      });

      this.setupEventHandlers();
    } catch (error) {
      console.error('[WS-Client] Connection error:', error);
      this.scheduleReconnect();
    }
  }

  /**
   * Set up WebSocket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      console.log('[WS-Client] Connected to server');
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.startHeartbeat();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log(
        `[WS-Client] Disconnected. Code: ${code}, Reason: ${reason.toString()}`
      );
      this.stopHeartbeat();

      if (!this.isIntentionallyClosed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (error: Error) => {
      console.error('[WS-Client] WebSocket error:', error);
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
          console.log('[WS-Client] Welcome message received:', message);
          break;

        case 'pong':
          // Heartbeat response
          break;

        case 'challenge':
          await this.handleChallenge(message.challenge);
          break;

        case 'challenge_verified':
          console.log('[WS-Client] Challenge verified successfully');
          break;

        case 'tool_execute':
          await this.handleToolExecutionRequest(
            message as ToolExecutionRequest
          );
          break;

        case 'error':
          console.error('[WS-Client] Server error:', message.error);
          break;

        default:
          console.warn('[WS-Client] Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('[WS-Client] Error parsing message:', error);
    }
  }

  /**
   * Handle tool execution request from server
   */
  private async handleToolExecutionRequest(
    request: ToolExecutionRequest
  ): Promise<void> {
    console.log(
      `[WS-Client] Tool execution request: ${request.serverName}.${request.toolName}`
    );

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

      console.log(
        `[WS-Client] Tool execution ${result.success ? 'succeeded' : 'failed'}: ${request.serverName}.${request.toolName}`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error('[WS-Client] Tool execution error:', error);

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
   * Handle challenge-response authentication
   */
  private async handleChallenge(challenge: string): Promise<void> {
    console.log('[WS-Client] Received authentication challenge');

    try {
      // Get JWT token to extract userId and sessionId
      const token = await this.getJWTToken();
      if (!token) {
        console.error('[WS-Client] No JWT token available for challenge response');
        return;
      }

      // Decode JWT to extract userId, tokenVersion, and iat
      const payload = this.decodeJWT(token);
      if (!payload || !payload.userId || payload.tokenVersion === undefined) {
        console.error('[WS-Client] Invalid JWT payload for challenge response');
        return;
      }

      // Compute sessionId the same way the server does
      // sessionId = SHA256(userId:tokenVersion:iat)
      const sessionId = crypto.createHash('sha256')
        .update(`${payload.userId}:${payload.tokenVersion}:${payload.iat || 0}`)
        .digest('hex');

      // Compute challenge response: SHA256(challenge + userId + sessionId)
      const responseString = `${challenge}${payload.userId}${sessionId}`;
      const response = crypto.createHash('sha256').update(responseString).digest('hex');

      console.log('[WS-Client] Sending challenge response');

      // Send challenge response to server
      this.sendMessage({
        type: 'challenge_response',
        response,
      });
    } catch (error) {
      console.error('[WS-Client] Error handling challenge:', error);
    }
  }

  /**
   * Decode JWT token to extract payload
   */
  private decodeJWT(token: string): { userId: string; tokenVersion: number; iat?: number } | null {
    try {
      // JWT format: header.payload.signature
      const parts = token.split('.');
      if (parts.length !== 3) {
        console.error('[WS-Client] Invalid JWT format');
        return null;
      }

      // Decode base64url payload
      const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
      return JSON.parse(payload);
    } catch (error) {
      console.error('[WS-Client] Error decoding JWT:', error);
      return null;
    }
  }

  /**
   * Send message to server
   */
  private sendMessage(message: WebSocketMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[WS-Client] Cannot send message - not connected');
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('[WS-Client] Error sending message:', error);
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

    console.log(
      `[WS-Client] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`
    );

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
    console.log('[WS-Client] Closing connection gracefully');
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
export function initializeWSClient(mainWindow: BrowserWindow): void {
  if (wsClient) {
    console.warn('[WS-Client] Already initialized');
    return;
  }

  wsClient = new WSClient(mainWindow);

  // Give the app a moment to load and establish session cookies
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
