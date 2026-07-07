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

    const parsed = tokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      return { kind: 'request_failed', message: 'invalid_response' };
    }

    return {
      kind: 'success',
      // `login --device` only ever requests `manage_keys offline_access`
      // (never a pure drive:* grant), so the token endpoint's `ok_mcp_token`
      // branch (oauth-repository.ts) never fires here — this is always the
      // classic OAuth refresh/access-token pair, hence the literal 'oauth'.
      tokens: {
        kind: 'oauth',
        accessToken: parsed.data.access_token,
        refreshToken: parsed.data.refresh_token,
        expiresIn: parsed.data.expires_in,
        scope: parsed.data.scope,
      },
    };
  };
}
