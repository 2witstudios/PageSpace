/**
 * RFC 8414 authorization server metadata discovery (Phase 4 task 3) — the
 * client-side counterpart to `apps/web/src/app/api/well-known/oauth-authorization-server`,
 * reached via the `/.well-known/oauth-authorization-server` rewrite in
 * apps/web/next.config.ts (Next.js App Router does not route dot-prefixed
 * folders under app/).
 * Zero trust: the fetched JSON is untrusted network input, validated with zod
 * before any field is trusted; a missing/malformed endpoint URL fails closed
 * rather than falling back to a guessed path.
 */
import { z } from 'zod';
import type { DiscoverMetadata, DiscoveredMetadata } from './loopback-flow.js';

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

const metadataSchema = z.object({
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  device_authorization_endpoint: z.string().url().optional(),
});

const WELL_KNOWN_PATH = '/.well-known/oauth-authorization-server';

/**
 * Discovery can run before ANY transport is connected — `pagespace mcp`
 * materializes auth on the first tool call of a server an MCP client already
 * considers live — so an unreachable host must surface as an error, never an
 * unbounded hang. Same abort shell as the SDK's transport/execute.ts.
 */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;

export interface DiscoverMetadataOptions {
  readonly timeoutMs?: number;
  /** Injected so tests can control abort deterministically without real timers/network. */
  readonly abortFactory?: () => AbortController;
}

export function createDiscoverMetadata(
  fetchImpl: typeof fetch = fetch,
  options: DiscoverMetadataOptions = {},
): DiscoverMetadata {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const abortFactory = options.abortFactory ?? (() => new AbortController());

  return async (host: string): Promise<DiscoveredMetadata> => {
    const url = `${host.replace(/\/+$/, '')}${WELL_KNOWN_PATH}`;

    const controller = abortFactory();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        throw new DiscoveryError(`Timed out reaching ${url} after ${timeoutMs}ms`);
      }
      throw new DiscoveryError(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new DiscoveryError(`${url} returned HTTP ${response.status}`);
    }

    const json: unknown = await response.json().catch(() => null);
    const parsed = metadataSchema.safeParse(json);
    if (!parsed.success) {
      throw new DiscoveryError(`${url} returned malformed authorization server metadata.`);
    }

    return {
      authorizationEndpoint: parsed.data.authorization_endpoint,
      tokenEndpoint: parsed.data.token_endpoint,
      deviceAuthorizationEndpoint: parsed.data.device_authorization_endpoint,
    };
  };
}
