/**
 * RFC 8414 authorization server metadata discovery — the CLI adapter over
 * `@pagespace/sdk`'s `discoverMetadata` (ADR 0004 Decision 11: the SDK owns
 * the token-endpoint helpers, the CLI imports them). The SDK fetches
 * `/.well-known/oauth-authorization-server` (reached via the rewrite in
 * apps/web/next.config.ts) and zod-validates it, failing closed on a missing
 * or malformed endpoint; this module keeps the CLI's own `DiscoveredMetadata`
 * shape and turns every failure into a `DiscoveryError` whose message names
 * the URL, as `pagespace login`/`whoami` print it.
 */
import { discoverMetadata, isNetworkError, isResponseValidationError } from '@pagespace/sdk';
import type { DiscoverMetadata, DiscoveredMetadata } from './loopback-flow.js';

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

const WELL_KNOWN_PATH = '/.well-known/oauth-authorization-server';

function describeFailure(url: string, error: unknown): string {
  if (isNetworkError(error)) {
    const cause = error.cause;
    return `Could not reach ${url}: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  if (isResponseValidationError(error)) {
    return `${url} returned malformed authorization server metadata.`;
  }
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return `${url} returned HTTP ${error.status}`;
  }
  return `${url} could not be read: ${error instanceof Error ? error.message : String(error)}`;
}

export function createDiscoverMetadata(fetchImpl: typeof fetch = fetch): DiscoverMetadata {
  return async (host: string): Promise<DiscoveredMetadata> => {
    const url = `${host.replace(/\/+$/, '')}${WELL_KNOWN_PATH}`;
    try {
      const metadata = await discoverMetadata(host, { fetch: fetchImpl });
      return {
        authorizationEndpoint: metadata.authorizationEndpoint,
        tokenEndpoint: metadata.tokenEndpoint,
        deviceAuthorizationEndpoint: metadata.deviceAuthorizationEndpoint,
      };
    } catch (error) {
      throw new DiscoveryError(describeFailure(url, error));
    }
  };
}
