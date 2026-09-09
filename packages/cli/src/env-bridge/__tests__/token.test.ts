import { describe, expect, it, vi } from 'vitest';
import { mintBridgeToken } from '../token.js';
import { generateMachineKeypair, signWithMachineKey } from '../keypair.js';
import type { MachineHostCredential } from '../../credentials/serialize.js';

const credential: MachineHostCredential = { kind: 'machine', privateKey: generateMachineKeypair().privateKey, enrollmentId: 'enr_1', envId: 'env_1', serverPublicKey: 'MCowBQYDK2VwAyEA', serverKeyId: 'k1', scopes: [], createdAt: '2026-09-05T09:00:00.000Z' };

function scriptedFetch() {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (init?.method === 'POST') return new Response(JSON.stringify({ token: 'tok', expiresInMs: 600_000, envId: 'env_1' }), { status: 200 });
    return new Response(JSON.stringify({ nonce: 'n', expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe('mintBridgeToken', () => {
  it('CWE-319: refuses a plaintext non-loopback host BEFORE any request leaves the machine', async () => {
    const { fetch, calls } = scriptedFetch();
    await expect(mintBridgeToken({ host: 'http://pagespace.ai', credential, fetch, sign: signWithMachineKey })).rejects.toThrow(/https/);
    expect(calls).toHaveLength(0);
  });

  it('CWE-200: both the challenge and the redemption refuse to follow redirects (redirect: "error"), so the proof can never be forwarded cross-origin', async () => {
    const { fetch, calls } = scriptedFetch();
    await expect(mintBridgeToken({ host: 'https://pagespace.ai', credential, fetch, sign: signWithMachineKey })).resolves.toMatchObject({ token: 'tok' });
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.init?.redirect).toBe('error');
  });

  it('a loopback http host is allowed for local development', async () => {
    const { fetch, calls } = scriptedFetch();
    await expect(mintBridgeToken({ host: 'http://localhost:3000', credential, fetch, sign: signWithMachineKey })).resolves.toMatchObject({ token: 'tok' });
    expect(calls[0]?.url).toMatch(/^http:\/\/localhost:3000\/api\/env-bridge\/token/);
  });
});
