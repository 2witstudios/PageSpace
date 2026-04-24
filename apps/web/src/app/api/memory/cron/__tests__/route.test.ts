import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import { assert } from '@/lib/memory/__tests__/riteway';
import { computeCronSignature } from '@/lib/auth/cron-auth';

/**
 * Memory Cron Route Tests
 *
 * The cron route orchestrates the memory pipeline:
 * 1. Gets paying users with recent activity
 * 2. Runs discovery passes for each user
 * 3. Evaluates and applies integration decisions
 * 4. Compacts fields if needed
 *
 * Key behaviors to test:
 * 1. Authentication via HMAC-SHA256 + nonce (see cron-auth.ts)
 * 2. Only processes paying users (pro, founder, business)
 * 3. Skips users with personalization disabled
 * 4. Handles errors for individual users without failing entire job
 * 5. Returns summary of processed/updated/errors
 */

// Mock database
const mockDbSelect = vi.fn();
const mockDbQuery = vi.fn();
vi.mock('@pagespace/db', () => ({
  db: {
    select: () => mockDbSelect(),
    query: {
      userPersonalization: {
        findFirst: () => mockDbQuery(),
      },
    },
  },
  users: { id: 'id', subscriptionTier: 'subscriptionTier' },
  userPersonalization: { userId: 'userId', enabled: 'enabled' },
  sessions: { userId: 'userId', type: 'type', revokedAt: 'revokedAt', lastUsedAt: 'lastUsedAt' },
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
}));

// Mock memory services
const mockRunDiscoveryPasses = vi.fn();
const mockEvaluateAndIntegrate = vi.fn();
const mockApplyIntegrationDecisions = vi.fn();
const mockGetCurrentPersonalization = vi.fn();
const mockCheckAndCompactIfNeeded = vi.fn();

vi.mock('@/lib/memory/discovery-service', () => ({
  runDiscoveryPasses: () => mockRunDiscoveryPasses(),
}));

vi.mock('@/lib/memory/integration-service', () => ({
  evaluateAndIntegrate: (...args: unknown[]) => mockEvaluateAndIntegrate(...args),
  applyIntegrationDecisions: (...args: unknown[]) => mockApplyIntegrationDecisions(...args),
  getCurrentPersonalization: () => mockGetCurrentPersonalization(),
}));

vi.mock('@/lib/memory/compaction-service', () => ({
  checkAndCompactIfNeeded: () => mockCheckAndCompactIfNeeded(),
}));

// Mock loggers
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

// Helper that creates a properly HMAC-signed cron request.
// The route validates HMAC-SHA256 signatures; tests that exercise non-auth
// behavior must send signed requests when CRON_SECRET is set in the env.
const TEST_SECRET = 'test-route-cron-secret';

function createSignedCronRequest(opts: {
  method?: string;
  url?: string;
  extraHeaders?: Record<string, string>;
} = {}): Request {
  const method = opts.method ?? 'POST';
  const url = opts.url ?? 'http://web:3000/api/memory/cron';
  const parsed = new URL(url);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = `nonce-${Math.random()}`;
  const signature = computeCronSignature(TEST_SECRET, timestamp, nonce, method, parsed.pathname);
  return new Request(url, {
    method,
    headers: {
      host: parsed.host,
      'x-cron-timestamp': timestamp,
      'x-cron-nonce': nonce,
      'x-cron-signature': signature,
      ...opts.extraHeaders,
    },
  });
}

describe('memory cron route', () => {
  let savedCronSecret: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    // Normalise CRON_SECRET so all tests run against a known secret state.
    // Tests that need no-secret (dev bypass) must clear it themselves.
    savedCronSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = TEST_SECRET;
    // Setup default mocks
    mockDbSelect.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([]),
          }),
        }),
        where: vi.fn().mockResolvedValue([]),
      }),
    });
  });

  afterEach(() => {
    if (savedCronSecret !== undefined) {
      process.env.CRON_SECRET = savedCronSecret;
    } else {
      delete process.env.CRON_SECRET;
    }
  });

  describe('cron authentication', () => {
    it('should return 403 when cron signature headers are missing', async () => {
      // CRON_SECRET is set by outer beforeEach; omitting HMAC headers must be rejected.
      const { POST } = await import('../route');
      const request = new Request('https://pagespace.ai/api/memory/cron', {
        method: 'POST',
        headers: { host: 'pagespace.ai' },
      });

      const response = await POST(request);
      const data = await response.json();

      assert({
        given: 'request with CRON_SECRET set but no HMAC headers',
        should: 'return 403 status',
        actual: response.status,
        expected: 403,
      });

      assert({
        given: 'request with CRON_SECRET set but no HMAC headers',
        should: 'return forbidden error mentioning missing headers',
        actual: data.error.includes('missing cron authentication headers'),
        expected: true,
      });
    });

    it('should pass a valid signed request with x-forwarded-for set (Next.js 15 regression)', async () => {
      // Next.js 15 unconditionally injects x-forwarded-for; the HMAC auth layer
      // must not be affected by its presence — only the signature headers matter.
      const { POST } = await import('../route');
      const request = createSignedCronRequest({
        extraHeaders: { 'x-forwarded-for': '172.18.0.1' },
      });

      const response = await POST(request);

      assert({
        given: 'valid signed request with x-forwarded-for header injected',
        should: 'not return 403 (x-forwarded-for is irrelevant to HMAC auth)',
        actual: response.status !== 403,
        expected: true,
      });
    });

    it('should accept a validly signed request from any origin', async () => {
      // Origin / host is not part of the HMAC message — only timestamp, nonce,
      // method, and path are signed.
      const { POST } = await import('../route');
      const request = createSignedCronRequest();

      const response = await POST(request);

      assert({
        given: 'validly signed cron request',
        should: 'not return 403',
        actual: response.status !== 403,
        expected: true,
      });
    });
  });

  describe('user filtering', () => {
    it('should return early when no active paying users found', async () => {
      mockDbSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });

      const { POST } = await import('../route');
      const request = createSignedCronRequest();

      const response = await POST(request);
      const data = await response.json();

      assert({
        given: 'no active paying users',
        should: 'return 200 with processed: 0',
        actual: data.processed,
        expected: 0,
      });
    });

    it('should skip users with personalization disabled', async () => {
      mockDbSelect
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                groupBy: vi.fn().mockResolvedValue([
                  { userId: 'disabled-user', subscriptionTier: 'pro' },
                ]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { userId: 'disabled-user', enabled: false },
            ]),
          }),
        });

      const { POST } = await import('../route');
      const request = createSignedCronRequest();

      const response = await POST(request);
      const data = await response.json();

      assert({
        given: 'user with personalization explicitly disabled',
        should: 'skip processing for that user',
        actual: data.processed,
        expected: 0,
      });

      assert({
        given: 'disabled personalization user',
        should: 'not run discovery passes',
        actual: mockRunDiscoveryPasses.mock.calls.length,
        expected: 0,
      });
    });
  });

  describe('GET support', () => {
    it('should support GET requests for cron services', async () => {
      const { GET } = await import('../route');
      const request = createSignedCronRequest({ method: 'GET' });

      const response = await GET(request);

      assert({
        given: 'valid signed GET request',
        should: 'return 200 status',
        actual: response.status,
        expected: 200,
      });
    });
  });
});
