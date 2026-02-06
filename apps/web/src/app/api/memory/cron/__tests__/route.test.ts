import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from '@/lib/memory/__tests__/riteway';

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
 * 1. Only accessible from internal network (CRON_SECRET + network origin check)
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
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

describe('memory cron route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
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

  describe('localhost authentication (zero trust)', () => {
    it('should return 403 when request comes from external host', async () => {
      const { POST } = await import('../route');
      const request = new Request('https://pagespace.ai/api/memory/cron', {
        method: 'POST',
        headers: { host: 'pagespace.ai' },
      });

      const response = await POST(request);
      const data = await response.json();

      assert({
        given: 'request from external host',
        should: 'return 403 status',
        actual: response.status,
        expected: 403,
      });

      assert({
        given: 'request from external host',
        should: 'return forbidden error mentioning internal network',
        actual: data.error.includes('internal network'),
        expected: true,
      });
    });

    it('should return 403 when x-forwarded-for header is present', async () => {
      const { POST } = await import('../route');
      const request = new Request('http://localhost:3000/api/memory/cron', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          'x-forwarded-for': '203.0.113.195',
        },
      });

      const response = await POST(request);

      assert({
        given: 'request with x-forwarded-for header (proxied)',
        should: 'return 403 status',
        actual: response.status,
        expected: 403,
      });
    });

    it('should proceed when request is from localhost', async () => {
      const { POST } = await import('../route');
      const request = new Request('http://localhost:3000/api/memory/cron', {
        method: 'POST',
        headers: { host: 'localhost:3000' },
      });

      const response = await POST(request);

      assert({
        given: 'request from localhost',
        should: 'not return 403',
        actual: response.status !== 403,
        expected: true,
      });
    });

    it('should proceed when request is from 127.0.0.1', async () => {
      const { POST } = await import('../route');
      const request = new Request('http://127.0.0.1:3000/api/memory/cron', {
        method: 'POST',
        headers: { host: '127.0.0.1:3000' },
      });

      const response = await POST(request);

      assert({
        given: 'request from 127.0.0.1',
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
      const request = new Request('http://localhost:3000/api/memory/cron', {
        method: 'POST',
        headers: { host: 'localhost:3000' },
      });

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
      const request = new Request('http://localhost:3000/api/memory/cron', {
        method: 'POST',
        headers: { host: 'localhost:3000' },
      });

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
      const request = new Request('http://localhost:3000/api/memory/cron', {
        method: 'GET',
        headers: { host: 'localhost:3000' },
      });

      const response = await GET(request);

      assert({
        given: 'GET request from localhost',
        should: 'return 200 status',
        actual: response.status,
        expected: 200,
      });
    });
  });
});
