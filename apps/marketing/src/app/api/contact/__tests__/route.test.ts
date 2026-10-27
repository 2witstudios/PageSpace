import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Marketing /api/contact — rate limiting contract test
 *
 * Given a contact form submission,
 * should use distributed rate limiting (checkDistributedRateLimit)
 * instead of an in-memory Map.
 */

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: {
      send: vi.fn().mockResolvedValue({ id: 'test-email-id' }),
    },
  })),
}));

vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(),
  DISTRIBUTED_RATE_LIMITS: {
    MARKETING_CONTACT_FORM: { maxAttempts: 5, windowMs: 3_600_000 },
  },
}));

import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';

const validPayload = {
  name: 'John Doe',
  email: 'john@example.com',
  subject: 'Hello there',
  message: 'This is a valid contact message with enough characters.',
};

const createRequest = (body: object, headers?: Record<string, string>) => {
  const bodyStr = JSON.stringify(body);
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '192.168.1.1',
      ...headers,
    },
    body: bodyStr,
  });
};

describe('marketing /api/contact rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true });
  });

  it('should call checkDistributedRateLimit with contact form config', async () => {
    const { POST } = await import('../route');
    const request = createRequest(validPayload);
    await POST(request);

    expect(checkDistributedRateLimit).toHaveBeenCalledWith(
      expect.stringContaining('192.168.1.1'),
      expect.objectContaining({ maxAttempts: 5, windowMs: 3_600_000 })
    );
  });

  it('should return 429 when distributed rate limit is exceeded', async () => {
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({
      allowed: false,
      retryAfter: 60,
    });

    const { POST } = await import('../route');
    const request = createRequest(validPayload);
    const response = await POST(request);

    expect(response.status).toBe(429);
  });

  it('should not use an in-memory Map for rate limiting', async () => {
    const routeModule = await import('../route');
    const routeSource = Object.keys(routeModule);

    // The module should export only POST, no rate limit Map or helper
    expect(routeSource).not.toContain('rateLimitMap');
    expect(routeSource).not.toContain('checkRateLimit');
  });
});
