import { getConnection, checkConnectionHealth } from '@/lib/websocket';
import { logger } from '@pagespace/lib';
import { validateLocalProviderURL } from '@pagespace/lib/security';
import type {
  FetchResponseStartMessage,
  FetchResponseChunkMessage,
  FetchResponseEndMessage,
  FetchResponseErrorMessage,
} from '@/lib/websocket/ws-message-schemas';

interface FetchResponseMeta {
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

interface PendingFetchRequest {
  controller: ReadableStreamDefaultController<Uint8Array>;
  headersResolve: (meta: FetchResponseMeta) => void;
  headersReject: (error: Error) => void;
  activityTimeout: NodeJS.Timeout;
  overallTimeout: NodeJS.Timeout;
  userId: string;
}

const ACTIVITY_TIMEOUT_MS = 120_000; // 120s between chunks (local models like LM Studio/Ollama need time to load)
const OVERALL_TIMEOUT_MS = 300_000; // 5min total

export class FetchBridge {
  private pendingRequests: Map<string, PendingFetchRequest> = new Map();
  private userRequests: Map<string, Set<string>> = new Map();
  private readonly logger = logger.child({ component: 'fetch-bridge' });

  /**
   * Proxy a fetch request through the user's desktop WebSocket connection.
   * Returns a standard Response with a streaming body.
   */
  async proxyFetch(
    userId: string,
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }
  ): Promise<Response> {
    const connection = getConnection(userId);

    if (!connection || connection.readyState !== 1) {
      throw new Error(
        'Desktop app not connected. Please ensure PageSpace Desktop is running and connected.'
      );
    }

    const health = checkConnectionHealth(connection);
    if (!health.isHealthy) {
      throw new Error(
        `Desktop connection unhealthy: ${health.reason}. Please reconnect PageSpace Desktop.`
      );
    }

    // Validate URL targets a local AI provider (blocks cloud metadata, non-local hosts)
    const urlValidation = await validateLocalProviderURL(url);
    if (!urlValidation.valid) {
      throw new Error(`URL validation failed: ${urlValidation.error}`);
    }

    // Check if already aborted before doing any work
    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const requestId = crypto.randomUUID();

    this.logger.info('Sending fetch request to desktop', {
      userId,
      url,
      method: init?.method ?? 'GET',
      requestId,
      action: 'send_fetch_request',
    });

    // Track request for this user
    let userSet = this.userRequests.get(userId);
    if (!userSet) {
      userSet = new Set();
      this.userRequests.set(userId, userSet);
    }
    userSet.add(requestId);

    let streamRef: ReadableStream<Uint8Array> | undefined;

    const headersPromise = new Promise<FetchResponseMeta>((resolve, reject) => {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const activityTimeout = setTimeout(() => {
            this.cleanupRequest(requestId, new Error(`Fetch activity timeout: no data received for ${ACTIVITY_TIMEOUT_MS / 1000}s`));
          }, ACTIVITY_TIMEOUT_MS);

          const overallTimeout = setTimeout(() => {
            this.cleanupRequest(requestId, new Error(`Fetch overall timeout after ${OVERALL_TIMEOUT_MS / 1000}s`));
          }, OVERALL_TIMEOUT_MS);

          this.pendingRequests.set(requestId, {
            controller,
            headersResolve: resolve,
            headersReject: reject,
            activityTimeout,
            overallTimeout,
            userId,
          });
        },
      });
      streamRef = stream;

      // Send the request message to the desktop client
      const message = {
        type: 'fetch_request' as const,
        id: requestId,
        url,
        method: init?.method ?? 'GET',
        headers: init?.headers ?? {},
        ...(init?.body !== undefined ? { body: init.body } : {}),
      };

      try {
        connection.send(JSON.stringify(message));
      } catch (error) {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.activityTimeout);
          clearTimeout(pending.overallTimeout);
          this.pendingRequests.delete(requestId);
          this.removeUserRequest(userId, requestId);
        }
        reject(
          new Error(
            `Failed to send fetch request: ${error instanceof Error ? error.message : String(error)}`
          )
        );
        return;
      }
    });

    // Wire AbortSignal to cancel the pending request
    if (init?.signal) {
      init.signal.addEventListener('abort', () => {
        this.cleanupRequest(requestId, new DOMException('The operation was aborted.', 'AbortError'));
      }, { once: true });
    }

    const meta = await headersPromise;

    this.logger.info('Fetch response headers received', {
      requestId,
      status: meta.status,
      action: 'fetch_response_start',
    });

    // Response constructor rejects body for null-body status codes (204, 205, 304)
    const isNullBodyStatus = meta.status === 204 || meta.status === 205 || meta.status === 304;
    const method = init?.method?.toUpperCase() ?? 'GET';
    const body = (isNullBodyStatus || method === 'HEAD') ? null : streamRef;

    return new Response(body, {
      status: meta.status,
      statusText: meta.statusText,
      headers: meta.headers,
    });
  }

  handleResponseStart(msg: FetchResponseStartMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      this.logger.warn('Received fetch_response_start for unknown request', {
        requestId: msg.id,
        action: 'handle_response_start',
      });
      return;
    }

    pending.headersResolve({
      status: msg.status,
      statusText: msg.statusText,
      headers: msg.headers,
    });
  }

  handleResponseChunk(msg: FetchResponseChunkMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      this.logger.warn('Received fetch_response_chunk for unknown request', {
        requestId: msg.id,
        action: 'handle_response_chunk',
      });
      return;
    }

    // Reset activity timeout
    clearTimeout(pending.activityTimeout);
    pending.activityTimeout = setTimeout(() => {
      this.cleanupRequest(msg.id, new Error(`Fetch activity timeout: no data received for ${ACTIVITY_TIMEOUT_MS / 1000}s`));
    }, ACTIVITY_TIMEOUT_MS);

    // Decode base64 chunk and enqueue (inside try to catch malformed base64)
    try {
      const bytes = Uint8Array.from(atob(msg.chunk), (c) => c.charCodeAt(0));
      pending.controller.enqueue(bytes);
    } catch (error) {
      this.cleanupRequest(
        msg.id,
        error instanceof Error ? error : new Error('Invalid fetch response chunk')
      );
    }
  }

  handleResponseEnd(msg: FetchResponseEndMessage): void {
    const pending = this.pendingRequests.get(msg.id);
    if (!pending) {
      this.logger.warn('Received fetch_response_end for unknown request', {
        requestId: msg.id,
        action: 'handle_response_end',
      });
      return;
    }

    clearTimeout(pending.activityTimeout);
    clearTimeout(pending.overallTimeout);

    try {
      pending.controller.close();
    } catch {
      // Stream already closed
    }

    this.pendingRequests.delete(msg.id);
    this.removeUserRequest(pending.userId, msg.id);

    this.logger.info('Fetch response complete', {
      requestId: msg.id,
      action: 'fetch_response_end',
    });
  }

  handleResponseError(msg: FetchResponseErrorMessage): void {
    this.cleanupRequest(msg.id, new Error(msg.error));
  }

  /**
   * Cancel all pending fetch requests for a user (e.g., on disconnect).
   */
  cancelUserRequests(userId: string): void {
    const requestIds = this.userRequests.get(userId);
    if (!requestIds || requestIds.size === 0) {
      return;
    }

    this.logger.info('Cancelling all fetch requests for disconnected user', {
      userId,
      count: requestIds.size,
      action: 'cancel_user_requests',
    });

    // Copy the set since cleanupRequest modifies it
    for (const requestId of [...requestIds]) {
      this.cleanupRequest(requestId, new Error('Desktop client disconnected'));
    }
  }

  isUserConnected(userId: string): boolean {
    const connection = getConnection(userId);
    if (!connection) return false;
    return checkConnectionHealth(connection).isHealthy;
  }

  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  private cleanupRequest(requestId: string, error?: Error): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;

    clearTimeout(pending.activityTimeout);
    clearTimeout(pending.overallTimeout);

    if (error) {
      // If headers haven't resolved yet, reject them
      pending.headersReject(error);

      // Also error the stream for consumers that already have the Response
      try {
        pending.controller.error(error);
      } catch {
        // Stream may already be closed/errored
      }

      this.logger.error('Fetch request failed', {
        requestId,
        error: error.message,
        action: 'fetch_request_error',
      });
    }

    this.pendingRequests.delete(requestId);
    this.removeUserRequest(pending.userId, requestId);
  }

  private removeUserRequest(userId: string, requestId: string): void {
    const userSet = this.userRequests.get(userId);
    if (userSet) {
      userSet.delete(requestId);
      if (userSet.size === 0) {
        this.userRequests.delete(userId);
      }
    }
  }
}

// Singleton instance
let fetchBridge: FetchBridge | null = null;

export function getFetchBridge(): FetchBridge {
  if (!fetchBridge) {
    fetchBridge = new FetchBridge();
  }
  return fetchBridge;
}

export function isFetchBridgeInitialized(): boolean {
  return fetchBridge !== null;
}
