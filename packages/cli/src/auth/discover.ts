/** RED stub — real RFC 8414 discovery fetch lands in GREEN. */
import type { DiscoverMetadata } from './loopback-flow.js';

export class DiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

export function createDiscoverMetadata(_fetchImpl: typeof fetch = fetch): DiscoverMetadata {
  return async () => {
    throw new Error('not implemented');
  };
}
