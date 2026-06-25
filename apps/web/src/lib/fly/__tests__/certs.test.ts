import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubGlobal('fetch', vi.fn());

import { addCertificate, getCertificate } from '../certs';

const FLY_API_URL = 'https://api.fly.io/graphql';
const TOKEN = 'fly-test-token';
const APP_NAME = 'pagespace-proxy';
const HOSTNAME = 'docs.acme.com';

function mockFetchOk(body: unknown) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(body),
  } as Response);
}

function mockFetchNetworkError() {
  (fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network failure'));
}

function mockFetchHttpError(status: number) {
  (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve({ errors: [{ message: `HTTP ${status}` }] }),
  } as unknown as Response);
}

function addCertOk(clientStatus: string) {
  return {
    data: { addCertificate: { certificate: { configured: true, clientStatus, hostname: HOSTNAME } } },
  };
}

function getCertOk(clientStatus: string) {
  return {
    data: { app: { certificate: { configured: true, clientStatus, hostname: HOSTNAME } } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FLY_API_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.FLY_API_TOKEN;
});

describe('addCertificate', () => {
  it('sends POST to Fly GraphQL with correct Authorization header', async () => {
    mockFetchOk(addCertOk('Awaiting certificates'));

    await addCertificate(APP_NAME, HOSTNAME);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(FLY_API_URL);
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('sends the mutation with appId (not appName) and hostname variables', async () => {
    mockFetchOk(addCertOk('Awaiting certificates'));

    await addCertificate(APP_NAME, HOSTNAME);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { query: string; variables: Record<string, string> };
    expect(body.variables.appId).toBe(APP_NAME);
    expect(body.variables.hostname).toBe(HOSTNAME);
    expect(body.variables.appName).toBeUndefined();
    expect(body.query).toContain('addCertificate(appId: $appId');
  });

  it('returns ok:true configured:false while the cert is not yet Ready', async () => {
    mockFetchOk(addCertOk('Awaiting configuration'));
    const result = await addCertificate(APP_NAME, HOSTNAME);
    expect(result).toEqual({ ok: true, configured: false });
  });

  it('returns ok:true configured:true when clientStatus is Ready', async () => {
    mockFetchOk(addCertOk('Ready'));
    const result = await addCertificate(APP_NAME, HOSTNAME);
    expect(result).toEqual({ ok: true, configured: true });
  });

  it('treats "Hostname already exists" as non-fatal and reads the existing cert status', async () => {
    // 1st call: addCertificate → "already exists" error
    mockFetchOk({ data: null, errors: [{ message: 'Hostname already exists on app' }] });
    // 2nd call: getCertificate → Ready
    mockFetchOk(getCertOk('Ready'));

    const result = await addCertificate(APP_NAME, HOSTNAME);

    expect(result).toEqual({ ok: true, configured: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [, secondInit] = (fetch as ReturnType<typeof vi.fn>).mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(secondInit.body as string) as { query: string; variables: Record<string, string> };
    expect(secondBody.query).toContain('app(name: $appName)');
    expect(secondBody.variables.appName).toBe(APP_NAME);
  });

  it('returns ok:false when FLY_API_TOKEN is absent', async () => {
    delete process.env.FLY_API_TOKEN;
    const result = await addCertificate(APP_NAME, HOSTNAME);
    expect(result.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns ok:false on network error', async () => {
    mockFetchNetworkError();
    const result = await addCertificate(APP_NAME, HOSTNAME);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/network failure/);
  });

  it('returns ok:false on HTTP error', async () => {
    mockFetchHttpError(401);
    const result = await addCertificate(APP_NAME, HOSTNAME);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false on a non-"already exists" GraphQL error', async () => {
    mockFetchOk({ data: null, errors: [{ message: 'app not found' }] });
    const result = await addCertificate(APP_NAME, HOSTNAME);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/app not found/);
  });
});

describe('getCertificate', () => {
  it('queries app(name:) and maps Ready → configured:true', async () => {
    mockFetchOk(getCertOk('Ready'));
    const result = await getCertificate(APP_NAME, HOSTNAME);
    expect(result).toEqual({ ok: true, configured: true });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { variables: Record<string, string> };
    expect(body.variables.appName).toBe(APP_NAME);
    expect(body.variables.hostname).toBe(HOSTNAME);
  });

  it('maps a non-Ready status to configured:false', async () => {
    mockFetchOk(getCertOk('Awaiting configuration'));
    const result = await getCertificate(APP_NAME, HOSTNAME);
    expect(result).toEqual({ ok: true, configured: false });
  });

  it('returns ok:false when the app/cert is missing', async () => {
    mockFetchOk({ data: { app: { certificate: null } } });
    const result = await getCertificate(APP_NAME, HOSTNAME);
    expect(result.ok).toBe(false);
  });
});
