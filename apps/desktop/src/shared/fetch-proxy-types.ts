/**
 * Type definitions for Fetch Proxy Bridge
 *
 * The fetch proxy allows the cloud server to make HTTP requests to local AI providers
 * (Ollama, LM Studio, etc.) through the desktop app's WebSocket connection.
 */

/** Incoming request from cloud server */
export interface FetchProxyRequest {
  type: 'fetch_request';
  /** Unique request ID for correlating response messages */
  id: string;
  /** Target URL (must pass allowlist validation) */
  url: string;
  /** HTTP method */
  method: string;
  /** HTTP headers */
  headers: Record<string, string>;
  /** Base64-encoded request body (optional) */
  body?: string;
}

/** Maximum chunk size in bytes for streaming response body */
export const FETCH_PROXY_CHUNK_SIZE = 65536; // 64KB

/** Overall timeout for fetch proxy requests in milliseconds (5 min safety backstop — matches server-side overall timeout) */
export const FETCH_PROXY_TIMEOUT_MS = 300000; // 5min

/** Maximum number of concurrent fetch proxy requests */
export const FETCH_PROXY_MAX_CONCURRENT = 10;

/** Maximum request body size in bytes (10MB) */
export const FETCH_PROXY_MAX_BODY_BYTES = 10 * 1024 * 1024;
