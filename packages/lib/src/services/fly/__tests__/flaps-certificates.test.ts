/**
 * The Machines API certificates resource.
 *
 * These four helpers replace hand-written GraphQL mutations, and the reason the
 * port is worth doing is asserted here rather than only asserted in prose: the
 * REST responses carry `dns_requirements` and `validation`, which name the exact
 * records a stuck hostname is waiting on — including the `_fly-ownership` TXT
 * that GraphQL had no equivalent for.
 *
 * The other property under test is CONVERGENCE. Certificates bill per hostname,
 * and both the request and the delete run from poll cycles that retry, so a
 * hostname already present must resolve to its existing certificate rather than
 * failing, and a hostname already absent must read as success.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  FlapsError,
  checkCertificate,
  deleteCertificate,
  getCertificate,
  requestAcmeCertificate,
  type FlapsTransport,
} from '../flaps-client';

const APP = 'pagespace-proxy';
const HOST = 'docs.acme.com';

interface Reply {
  status: number;
  body?: unknown;
}

/** A transport that replays queued responses and records every request. */
function stubTransport(replies: Reply[]): {
  transport: FlapsTransport;
  calls: Array<{ method: string; url: string; body: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const queue = [...replies];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const reply = queue.shift();
    if (!reply) throw new Error('stub transport received an unexpected extra request');
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    calls,
    transport: { token: 'test-token', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
  };
}

const PENDING_CERT = {
  hostname: HOST,
  status: 'pending_validation',
  configured: false,
  dns_requirements: {
    ownership: {
      name: `_fly-ownership.${HOST}`,
      app_value: 'app-ABC123',
      org_value: 'org-XYZ789',
    },
  },
  validation: { ownership_txt_configured: false },
};

const ACTIVE_CERT = { hostname: HOST, status: 'active', configured: true };

describe('requestAcmeCertificate — the ACME request', () => {
  it('given a new hostname, should POST it to the app certificates/acme endpoint', async () => {
    const { transport, calls } = stubTransport([{ status: 200, body: PENDING_CERT }]);
    const cert = await requestAcmeCertificate(transport, APP, HOST);

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain(`/v1/apps/${APP}/certificates/acme`);
    expect(calls[0].body).toEqual({ hostname: HOST });
    expect(cert.status).toBe('pending_validation');
  });

  it('given a pending certificate, should carry the ownership record the customer still owes', async () => {
    const { transport } = stubTransport([{ status: 200, body: PENDING_CERT }]);
    const cert = await requestAcmeCertificate(transport, APP, HOST);
    // This is the whole reason for the port: GraphQL returned no equivalent.
    expect(cert.dns_requirements?.ownership?.app_value).toBe('app-ABC123');
    expect(cert.validation?.ownership_txt_configured).toBe(false);
  });

  it('given a hostname Fly already has, should resolve to the existing certificate rather than fail', async () => {
    const { transport, calls } = stubTransport([
      { status: 422, body: { error: 'Hostname already exists on app' } },
      { status: 200, body: ACTIVE_CERT },
    ]);
    const cert = await requestAcmeCertificate(transport, APP, HOST);
    expect(cert.status).toBe('active');
    expect(calls[1].method).toBe('GET');
  });

  it('given a hostname needing escaping, should encode it into the path', async () => {
    const { transport, calls } = stubTransport([{ status: 200, body: ACTIVE_CERT }]);
    await getCertificate(transport, 'app/with slash', 'a b.com');
    expect(calls[0].url).toContain('app%2Fwith%20slash');
    expect(calls[0].url).toContain('a%20b.com');
  });

  it('given a genuine failure, should throw rather than report a certificate', async () => {
    const { transport } = stubTransport([{ status: 403, body: { error: 'unauthorized' } }]);
    await expect(requestAcmeCertificate(transport, APP, HOST)).rejects.toThrow(FlapsError);
  });

  it('given a 2xx whose body is not an object, should throw rather than return a non-certificate', async () => {
    const { transport } = stubTransport([{ status: 200, body: ['not', 'a', 'cert'] }]);
    await expect(requestAcmeCertificate(transport, APP, HOST)).rejects.toThrow(FlapsError);
  });
});

describe('getCertificate — a 404 is an answer, not an error', () => {
  it('given a hostname the app does not have, should return null', async () => {
    const { transport } = stubTransport([{ status: 404, body: { error: 'not found' } }]);
    expect(await getCertificate(transport, APP, HOST)).toBeNull();
  });

  it('given an existing certificate, should return it without requesting anything', async () => {
    const { transport, calls } = stubTransport([{ status: 200, body: ACTIVE_CERT }]);
    const cert = await getCertificate(transport, APP, HOST);
    expect(cert?.status).toBe('active');
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });

  it('given a server error, should still throw', async () => {
    const { transport } = stubTransport([
      { status: 500, body: { error: 'boom' } },
      { status: 500, body: { error: 'boom' } },
      { status: 500, body: { error: 'boom' } },
      { status: 500, body: { error: 'boom' } },
    ]);
    await expect(getCertificate(transport, APP, HOST)).rejects.toThrow(FlapsError);
  });
});

describe('checkCertificate — asking Fly to re-read DNS', () => {
  it('given a hostname, should POST to its check endpoint', async () => {
    const { transport, calls } = stubTransport([{ status: 200, body: ACTIVE_CERT }]);
    await checkCertificate(transport, APP, HOST);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain(`/certificates/${HOST}/check`);
  });

  it('given a hostname Fly does not have, should return null', async () => {
    const { transport } = stubTransport([{ status: 404, body: { error: 'not found' } }]);
    expect(await checkCertificate(transport, APP, HOST)).toBeNull();
  });
});

describe('deleteCertificate — idempotent, because certs bill per hostname', () => {
  it('given an attached hostname, should DELETE it', async () => {
    const { transport, calls } = stubTransport([{ status: 204 }]);
    await expect(deleteCertificate(transport, APP, HOST)).resolves.toBeUndefined();
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain(`/certificates/${HOST}`);
  });

  it('given a hostname already gone, should treat the 404 as the desired end state', async () => {
    const { transport } = stubTransport([{ status: 404, body: { error: 'not found' } }]);
    await expect(deleteCertificate(transport, APP, HOST)).resolves.toBeUndefined();
  });

  it('given a refusal, should throw so a billing hostname is never assumed removed', async () => {
    const { transport } = stubTransport([{ status: 403, body: { error: 'forbidden' } }]);
    await expect(deleteCertificate(transport, APP, HOST)).rejects.toThrow(FlapsError);
  });
});
