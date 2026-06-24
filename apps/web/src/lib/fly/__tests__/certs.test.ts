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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FLY_API_TOKEN = TOKEN;
});

afterEach(() => {
  delete process.env.FLY_API_TOKEN;
});

describe('addCertificate', () => {
  it('sends POST to Fly GraphQL with correct Authorization header', async () => {
    mockFetchOk({
      data: { addCertificate: { certificate: { configured: false, hostname: HOSTNAME } } },
    });

    await addCertificate(APP_NAME, HOSTNAME);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(FLY_API_URL);
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('sends mutation with appName and hostname variables', async () => {
    mockFetchOk({
      data: { addCertificate: { certificate: { configured: false, hostname: HOSTNAME } } },
    });

    await addCertificate(APP_NAME, HOSTNAME);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { variables: Record<string, string> };
    expect(body.variables.appName).toBe(APP_NAME);
    expect(body.variables.hostname).toBe(HOSTNAME);
  });

  it('returns ok:true with configured:false when cert is provisioning', async () => {
    mockFetchOk({
      data: { addCertificate: { certificate: { configured: false, hostname: HOSTNAME } } },
    });

    const result = await addCertificate(APP_NAME, HOSTNAME);
    expect(result).toEqual({ ok: true, configured: false });
  });

  it('returns ok:true with configured:true when cert is already ready', async () => {
    mockFetchOk({
      data: { addCertificate: { certificate: { configured: true, hostname: HOSTNAME } } },
    });

    const result = await addCertificate(APP_NAME, HOSTNAME);
    expect(result).toEqual({ ok: true, configured: true });
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

  it('returns ok:false when GraphQL response has errors', async () => {
    mockFetchOk({ data: null, errors: [{ message: 'app not found' }] });
    const result = await addCertificate(APP_NAME, HOSTNAME);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/app not found/);
  });
});

describe('getCertificate', () => {
  it('sends query with appName and hostname variables', async () => {
    mockFetchOk({
      data: { app: { certificate: { configured: true, hostname: HOSTNAME } } },
    });

    await getCertificate(APP_NAME, HOSTNAME);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { variables: Record<string, string> };
    expect(body.variables.appName).toBe(APP_NAME);
    expect(body.variables.hostname).toBe(HOSTNAME);
  });

  it('returns ok:true with configured:true when cert exists and is configured', async () => {
    mockFetchOk({
      data: { app: { certificate: { configured: true, hostname: HOSTNAME } } },
    });

    const result = await getCertificate(APP_NAME, HOSTNAME);
    expect(result).toEqual({ ok: true, configured: true });
  });

  it('returns ok:true with configured:false when cert exists but not ready', async () => {
    mockFetchOk({
      data: { app: { certificate: { configured: false, hostname: HOSTNAME } } },
    });

    const result = await getCertificate(APP_NAME, HOSTNAME);
    expect(result).toEqual({ ok: true, configured: false });
  });

  it('returns ok:false when certificate is null (not found)', async () => {
    mockFetchOk({
      data: { app: { certificate: null } },
    });

    const result = await getCertificate(APP_NAME, HOSTNAME);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not found/i);
  });

  it('returns ok:false when FLY_API_TOKEN is absent', async () => {
    delete process.env.FLY_API_TOKEN;
    const result = await getCertificate(APP_NAME, HOSTNAME);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false on network error', async () => {
    mockFetchNetworkError();
    const result = await getCertificate(APP_NAME, HOSTNAME);
    expect(result.ok).toBe(false);
  });
});
