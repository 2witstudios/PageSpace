/**
 * RFC 8628 §3.4 device-code token polling — POSTs the device_code grant to
 * the same token endpoint `exchange-code.ts` uses for authorization_code
 * (`apps/web/src/app/api/oauth/token/route.ts`'s `handleDeviceCodeGrant`).
 * Classifies the RFC 8628 §3.5 poll outcomes
 * (authorization_pending/slow_down/access_denied/expired_token) as distinct
 * `DeviceTokenResult` variants rather than throwing, so `decideNextPoll`
 * never needs to parse an error string to decide what happened.
 */
import type { DeviceTokenResult, PollDeviceToken } from './device-flow.js';
import { parseTokenResponse } from './token-response.js';

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

function extractErrorCode(json: unknown): string | null {
  if (json !== null && typeof json === 'object' && 'error' in json && typeof (json as Record<string, unknown>).error === 'string') {
    return (json as Record<string, unknown>).error as string;
  }
  return null;
}

export function createPollDeviceToken(fetchImpl: typeof fetch = fetch): PollDeviceToken {
  return async (params): Promise<DeviceTokenResult> => {
    const body = new URLSearchParams({
      grant_type: DEVICE_GRANT_TYPE,
      device_code: params.deviceCode,
      client_id: params.clientId,
    });

    let response: Response;
    try {
      response = await fetchImpl(params.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      return { kind: 'request_failed', message: `network_error: ${error instanceof Error ? error.message : String(error)}` };
    }

    const json: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const errorCode = extractErrorCode(json);
      switch (errorCode) {
        case 'authorization_pending':
          return { kind: 'authorization_pending' };
        case 'slow_down':
          return { kind: 'slow_down' };
        case 'access_denied':
          return { kind: 'access_denied' };
        case 'expired_token':
          return { kind: 'expired_token' };
        default:
          return { kind: 'request_failed', message: errorCode ?? `http_${response.status}` };
      }
    }

    // Discriminated through the SAME parser the authorization_code exchange
    // uses (`token-response.ts`): the device grant now redeems key-shaped
    // grants too, so any of the four shapes can arrive here. `runDeviceLogin`
    // is what decides whether the shape it got is the one this particular
    // flow asked for.
    const tokens = parseTokenResponse(json);
    if (tokens === null) {
      return { kind: 'request_failed', message: 'invalid_response' };
    }

    return { kind: 'success', tokens };
  };
}
