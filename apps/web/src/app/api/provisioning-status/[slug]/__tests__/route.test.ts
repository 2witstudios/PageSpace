import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from '../route';

const originalFetch = global.fetch;

describe('GET /api/provisioning-status/[slug]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONTROL_PLANE_URL = 'http://control-plane:4000';
    process.env.CONTROL_PLANE_API_KEY = 'test-api-key';
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONTROL_PLANE_URL;
    delete process.env.CONTROL_PLANE_API_KEY;
  });

  function makeRequest(slug: string) {
    const request = new Request(`https://example.com/api/provisioning-status/${slug}`);
    const context = { params: Promise.resolve({ slug }) };
    return { request, context };
  }

  it('should proxy to control-plane and return tenant status', async () => {
    const tenantData = { slug: 'acme', status: 'provisioning', name: 'acme' };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => tenantData,
    });

    const { request, context } = makeRequest('acme');
    const response = await GET(request, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.slug).toBe('acme');
    expect(body.status).toBe('provisioning');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://control-plane:4000/api/tenants/acme',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-API-Key': 'test-api-key',
        }),
      }),
    );
  });

  it('should return active status when tenant is ready', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ slug: 'acme', status: 'active', name: 'acme' }),
    });

    const { request, context } = makeRequest('acme');
    const response = await GET(request, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('active');
  });

  it('should return failed status when provisioning fails', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ slug: 'acme', status: 'failed', name: 'acme' }),
    });

    const { request, context } = makeRequest('acme');
    const response = await GET(request, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.status).toBe('failed');
  });

  it('should return 404 when tenant not found on control-plane', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Tenant "unknown" not found' }),
    });

    const { request, context } = makeRequest('unknown');
    const response = await GET(request, context);

    expect(response.status).toBe(404);
  });

  it('should return 503 when CONTROL_PLANE_URL is not configured', async () => {
    delete process.env.CONTROL_PLANE_URL;

    const { request, context } = makeRequest('acme');
    const response = await GET(request, context);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe('Provisioning service unavailable');
  });

  it('should return 502 when control-plane is unreachable', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Connection refused')
    );

    const { request, context } = makeRequest('acme');
    const response = await GET(request, context);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error).toBe('Failed to reach provisioning service');
  });

  it('should only return slug and status fields to the client', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        slug: 'acme',
        status: 'active',
        name: 'acme',
        ownerEmail: 'secret@acme.com',
        tier: 'business',
        recentEvents: [],
      }),
    });

    const { request, context } = makeRequest('acme');
    const response = await GET(request, context);
    const body = await response.json();

    expect(body.slug).toBe('acme');
    expect(body.status).toBe('active');
    expect(body.ownerEmail).toBeUndefined();
    expect(body.tier).toBeUndefined();
    expect(body.recentEvents).toBeUndefined();
  });

  describe('slug validation', () => {
    it('should return 400 for slug with path traversal characters', async () => {
      const { request, context } = makeRequest('../../etc/passwd');
      const response = await GET(request, context);

      expect(response.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return 400 for slug that is too short', async () => {
      const { request, context } = makeRequest('ab');
      const response = await GET(request, context);

      expect(response.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return 400 for slug with uppercase letters', async () => {
      const { request, context } = makeRequest('AcMe');
      const response = await GET(request, context);

      expect(response.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should return 400 for slug with spaces', async () => {
      const { request, context } = makeRequest('my tenant');
      const response = await GET(request, context);

      expect(response.status).toBe(400);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });
});
