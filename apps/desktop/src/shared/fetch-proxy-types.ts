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

/** Response headers sent back to cloud */
export interface FetchProxyResponseStart {
  type: 'fetch_response_start';
  id: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

/** Streamed body chunk (base64-encoded, max 64KB) */
export interface FetchProxyResponseChunk {
  type: 'fetch_response_chunk';
  id: string;
  chunk: string;
}

/** Signals end of response body */
export interface FetchProxyResponseEnd {
  type: 'fetch_response_end';
  id: string;
}

/** Error during fetch proxy execution */
export interface FetchProxyResponseError {
  type: 'fetch_response_error';
  id: string;
  error: string;
}

/** All possible fetch proxy response message types */
export type FetchProxyResponse =
  | FetchProxyResponseStart
  | FetchProxyResponseChunk
  | FetchProxyResponseEnd
  | FetchProxyResponseError;

/** Maximum chunk size in bytes for streaming response body */
export const FETCH_PROXY_CHUNK_SIZE = 65536; // 64KB

/** Overall timeout for fetch proxy requests in milliseconds (5 min safety backstop — server-side 30s activity timeout is the real guard) */
export const FETCH_PROXY_TIMEOUT_MS = 300000; // 5min

/** Maximum number of concurrent fetch proxy requests */
export const FETCH_PROXY_MAX_CONCURRENT = 10;

/** Maximum request body size in bytes (10MB) */
export const FETCH_PROXY_MAX_BODY_BYTES = 10 * 1024 * 1024;
