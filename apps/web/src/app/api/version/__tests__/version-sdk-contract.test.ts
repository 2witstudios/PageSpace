/**
 * The composed CLI->server contract test the epic lacked (ADR 0001, plan
 * section W3): every prior SDK version-check test feeds `checkServerCompatibility`
 * plain fixture values, and every prior server header test reads
 * `response.headers.get(...)` directly — neither exercises the two wired
 * together. This test constructs a real `PageSpaceClient` (no
 * `skipVersionCheck`) and drives it against the actual `GET /api/version`
 * route handler and the actual `applySecurityHeaders` seam
 * (`@/middleware/security-headers`, ADR 0001 D2) that stamps
 * `X-PageSpace-API-Version` on real `/api/*` responses. If either side of
 * the contract drifts — the header stops being emitted, or the SDK's
 * compatibility check regresses — this is the test that fails.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { NextResponse } from 'next/server';
import {
  defineOperation,
  isIncompatibleServerError,
  PageSpaceClient,
  type AuthProvider,
} from '@pagespace/sdk';
import { API_CONTRACT_VERSION } from '@pagespace/lib/api-contract-version';
import { applySecurityHeaders } from '@/middleware/security-headers';
import { GET } from '../route';

const getVersion = defineOperation({
  name: 'version.get',
  method: 'GET',
  path: '/api/version',
  inputSchema: z.object({}),
  outputSchema: z.object({ service: z.string(), apiVersion: z.string() }),
  description: 'ADR 0001 D2 eager-handshake endpoint.',
});

function fakeAuth(): AuthProvider {
  return { getAccessToken: vi.fn(async () => 'token-1'), invalidate: vi.fn() };
}

function makeClient(fetchImpl: typeof fetch): PageSpaceClient {
  return new PageSpaceClient({
    baseUrl: 'https://pagespace.ai',
    auth: fakeAuth(),
    jitter: () => 0,
    timeoutMs: 1000,
    fetch: fetchImpl,
  });
}

describe('SDK <-> server assembled version contract', () => {
  it('succeeds with no IncompatibleServerError when the real route handler response is stamped by the real applySecurityHeaders seam', async () => {
    const fetchImpl = (async () => {
      const response = await GET();
      applySecurityHeaders(response as unknown as NextResponse, {
        nonce: 'test-nonce',
        isProduction: false,
        isAPIRoute: true,
      });
      return response;
    }) as unknown as typeof fetch;

    const client = makeClient(fetchImpl);

    await expect(client.invoke(getVersion, {})).resolves.toEqual({
      service: 'pagespace-web',
      apiVersion: API_CONTRACT_VERSION,
    });
  });

  it('regression guard: the real route handler response WITHOUT the header stamp throws IncompatibleServerError', async () => {
    const fetchImpl = (async () => GET()) as unknown as typeof fetch;
    const client = makeClient(fetchImpl);

    const error = await client.invoke(getVersion, {}).catch((e: unknown) => e);
    expect(isIncompatibleServerError(error)).toBe(true);
  });
});
