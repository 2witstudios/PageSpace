/** RED stub — real form-encoded token exchange lands in GREEN. */
import type { ExchangeCode } from './loopback-flow.js';

export class TokenExchangeError extends Error {
  constructor(public readonly code: string) {
    super(`Token exchange failed: ${code}`);
    this.name = 'TokenExchangeError';
  }
}

export function createExchangeCode(_fetchImpl: typeof fetch = fetch): ExchangeCode {
  return async () => {
    throw new Error('not implemented');
  };
}
