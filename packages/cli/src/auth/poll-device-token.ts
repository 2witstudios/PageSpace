/**
 * RFC 8628 §3.4 device-code token polling — POSTs the device_code grant to
 * the same token endpoint `exchange-code.ts` uses for authorization_code
 * (`apps/web/src/app/api/oauth/token/route.ts`'s `handleDeviceCodeGrant`).
 * Classifies the RFC 8628 §3.5 poll outcomes
 * (authorization_pending/slow_down/access_denied/expired_token) as distinct
 * `DeviceTokenResult` variants rather than throwing, so `decideNextPoll`
 * never needs to parse an error string to decide what happened.
 */
import { z } from 'zod';
import type { DeviceTokenResult, PollDeviceToken } from './device-flow.js';

const tokenResponseSchema = z.object({
  access_token: z.string(),
  token_type: z.string(),
  expires_in: z.number(),
  refresh_token: z.string(),
  scope: z.string(),
});

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

function extractErrorCode(json: unknown): string | null {
  if (json !== null && typeof json === 'object' && 'error' in json && typeof (json as Record<string, unknown>).error === 'string') {
    return (json as Record<string, unknown>).error as string;
  }
  return null;
}

export function createPollDeviceToken(_fetchImpl: typeof fetch = fetch): PollDeviceToken {
  return async (_params): Promise<DeviceTokenResult> => {
    throw new Error('not implemented');
  };
}
