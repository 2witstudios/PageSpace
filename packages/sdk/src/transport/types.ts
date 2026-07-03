import type { z } from 'zod';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The subset of an operation descriptor (full shape lands in task 5's
 * `defineOperation`) that buildRequest/parseResponse need: enough to
 * interpolate the path, serialize the rest, and validate the response.
 */
export interface TransportOperation<TOutput = unknown> {
  readonly name: string;
  readonly method: HttpMethod;
  /** Template path with `:paramName` segments, e.g. `/api/drives/:driveId/pages`. */
  readonly path: string;
  readonly outputSchema: z.ZodType<TOutput>;
  /** Set for export-style operations whose 2xx body is raw text, not JSON. */
  readonly textResponse?: boolean;
}

/**
 * Client-wide config threaded into buildRequest. Deliberately has no token/
 * credential field — the facade (task 6) attaches Authorization from the
 * AuthProvider; buildRequest must never see one.
 */
export interface ClientConfig {
  readonly baseUrl: string;
  /** Overrides the request's X-PageSpace-API-Version header; defaults to MIN_SERVER_API_VERSION. */
  readonly apiVersion?: string;
}

export interface RequestDescriptor {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}
