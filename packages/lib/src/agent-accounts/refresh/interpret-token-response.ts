import type { SendOutcome } from '../executor/pinned-https-client';
import type { RefreshFailure } from './classify-refresh-failure';

export type TokenResponseReading = { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly failure: RefreshFailure };

export function interpretTokenResponse(_input: { readonly send: SendOutcome; readonly now: number }): TokenResponseReading {
  throw new Error('interpretTokenResponse: not implemented (RED)');
}
