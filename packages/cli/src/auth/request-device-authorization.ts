/**
 * RFC 8628 §3.1 device authorization request — the client-side counterpart
 * to `apps/web/src/app/api/oauth/device_authorization/route.ts` (Phase 1
 * task 9). Form-encoded POST, unauthenticated — same reasoning as
 * `exchange-code.ts` for staying outside `PageSpaceClient.invoke()` (no
 * Bearer token exists yet). Zero trust: the response is untrusted network
 * input, validated with zod before any field is trusted.
 */
import { z } from 'zod';
import type { DeviceAuthorization, RequestDeviceAuthorization } from './device-flow.js';

export class DeviceAuthorizationError extends Error {
  constructor(public readonly code: string) {
    super(`Device authorization request failed: ${code}`);
    this.name = 'DeviceAuthorizationError';
  }
}

const deviceAuthorizationResponseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  expires_in: z.number(),
  interval: z.number(),
});

function extractErrorCode(json: unknown, status: number): string {
  if (json !== null && typeof json === 'object' && 'error' in json && typeof (json as Record<string, unknown>).error === 'string') {
    return (json as Record<string, unknown>).error as string;
  }
  return `http_${status}`;
}

export function createRequestDeviceAuthorization(fetchImpl: typeof fetch = fetch): RequestDeviceAuthorization {
  return async (params): Promise<DeviceAuthorization> => {
    const body = new URLSearchParams({ client_id: params.clientId, scope: params.scope });

    let response: Response;
    try {
      response = await fetchImpl(params.deviceAuthorizationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch (error) {
      throw new DeviceAuthorizationError(`network_error: ${error instanceof Error ? error.message : String(error)}`);
    }

    const json: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      throw new DeviceAuthorizationError(extractErrorCode(json, response.status));
    }

    const parsed = deviceAuthorizationResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new DeviceAuthorizationError('invalid_response');
    }

    return {
      deviceCode: parsed.data.device_code,
      userCode: parsed.data.user_code,
      verificationUri: parsed.data.verification_uri,
      verificationUriComplete: parsed.data.verification_uri_complete,
      expiresInSeconds: parsed.data.expires_in,
      intervalSeconds: parsed.data.interval,
    };
  };
}
