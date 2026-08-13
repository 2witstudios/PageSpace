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
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => mockDbSelect(),
    query: {
      userPersonalization: {
        findFirst: () => mockDbQuery(),
      },
    },
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', subscriptionTier: 'subscriptionTier' },
}));
vi.mock('@pagespace/db/schema/sessions', () => ({
  sessions: { userId: 'userId', type: 'type', revokedAt: 'revokedAt', lastUsedAt: 'lastUsedAt' },
}));
vi.mock('@pagespace/db/schema/personalization', () => ({
  userPersonalization: { userId: 'userId', enabled: 'enabled' },
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
  getCurrentPersonalizationPages: () => mockGetCurrentPersonalization(),
}));

vi.mock('@/lib/memory/compaction-service', () => ({
  checkAndCompactIfNeeded: () => mockCheckAndCompactIfNeeded(),
}));

// Candidate lifecycle. These record WHICH ids were settled, which is the whole
// point of the settlement tests below: the P1 defects in review were all cases
// where the wrong candidates were retired.
const mockUpsertCandidates = vi.fn();
const mockFindPromotableCandidates = vi.fn();
const mockMarkCandidatesPromoted = vi.fn();
const mockMarkCandidatesRejected = vi.fn();
const mockPruneStaleCandidates = vi.fn();
const mockRedactSettledEvidence = vi.fn();

vi.mock('@/lib/memory/candidate-service', () => ({
  upsertCandidates: (...args: unknown[]) => mockUpsertCandidates(...args),
  findPromotableCandidates: (...args: unknown[]) => mockFindPromotableCandidates(...args),
  markCandidatesPromoted: (...args: unknown[]) => mockMarkCandidatesPromoted(...args),
  markCandidatesRejected: (...args: unknown[]) => mockMarkCandidatesRejected(...args),
  pruneStaleCandidates: (...args: unknown[]) => mockPruneStaleCandidates(...args),
  redactSettledEvidence: (...args: unknown[]) => mockRedactSettledEvidence(...args),
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

  /**
   * Candidate settlement — where every P1 in review lived.
   *
   * Settling the wrong candidate is silent and permanent: a retired claim is
   * never re-staged, so a preference the user keeps expressing simply stops
   * being learned, with nothing in the profile to show it was ever considered.
   */
  describe('candidate settlement', () => {
    const candidate = (id: string, field = 'rules') => ({
      id,
      userId: 'user-1',
      field,
      claim: `claim ${id}`,
      claimKey: `claim ${id}`,
      evidence: 'e',
      occurrences: 2,
      firstSeenAt: new Date('2026-03-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-03-02T00:00:00.000Z'),
      promotedAt: null,
      rejectedAt: null,
    });

    /** One active paying user with personalization on. */
    function setupOneUser() {
      mockDbSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([
                { userId: 'user-1', subscriptionTier: 'pro' },
              ]),
            }),
          }),
          where: vi.fn().mockResolvedValue([{ userId: 'user-1', enabled: true }]),
        }),
      });
      mockRunDiscoveryPasses.mockResolvedValue({ claims: [] });
      mockGetCurrentPersonalization.mockResolvedValue({});
      mockCheckAndCompactIfNeeded.mockResolvedValue({ compacted: false, fields: [] });
      mockPruneStaleCandidates.mockResolvedValue(0);
      mockRedactSettledEvidence.mockResolvedValue(0);
    }

    beforeEach(setupOneUser);

    it('leaves every candidate pending when evaluation never reached a decision', async () => {
      // A provider outage must not retire a user's whole ready set. Before the
      // fix, an empty update object was indistinguishable from "declined all".
      mockFindPromotableCandidates.mockResolvedValue([candidate('c1'), candidate('c2')]);
      mockEvaluateAndIntegrate.mockResolvedValue({ ok: false, reason: 'provider error' });

      const { POST } = await import('../route');
      await POST(createSignedCronRequest());

      assert({
        given: 'an evaluator failure',
        should: 'settle nothing, so the next run can retry',
        actual: {
          promoted: mockMarkCandidatesPromoted.mock.calls.length,
          rejected: mockMarkCandidatesRejected.mock.calls.length,
          applied: mockApplyIntegrationDecisions.mock.calls.length,
        },
        expected: { promoted: 0, rejected: 0, applied: 0 },
      });
    });

    it('promotes only the candidates the evaluator actually used', async () => {
      // Two candidates share a field. The evaluator uses one. Settling by field
      // promoted both — retiring a claim that never reached the page.
      mockFindPromotableCandidates.mockResolvedValue([candidate('c1'), candidate('c2')]);
      mockEvaluateAndIntegrate.mockResolvedValue({
        ok: true,
        updates: { rules: 'new rules content' },
        usedCandidateIds: ['c1'],
      });
      mockApplyIntegrationDecisions.mockResolvedValue({
        updated: true,
        fields: ['rules'],
        rejected: [],
      });

      const { POST } = await import('../route');
      await POST(createSignedCronRequest());

      assert({
        given: 'two candidates in one field where the evaluator used one',
        should: 'promote the used one and reject the other, not promote both',
        actual: {
          promoted: mockMarkCandidatesPromoted.mock.calls[0]?.[0],
          rejected: mockMarkCandidatesRejected.mock.calls[0]?.[0],
        },
        expected: { promoted: ['c1'], rejected: ['c2'] },
      });
    });

    it('leaves a cited candidate pending when its page write was blocked', async () => {
      // The evaluator wanted it, but a guard or a missing pointer stopped the
      // write. Promoting here would retire a claim with nothing in the profile.
      mockFindPromotableCandidates.mockResolvedValue([candidate('c1')]);
      mockEvaluateAndIntegrate.mockResolvedValue({
        ok: true,
        updates: { rules: 'x' },
        usedCandidateIds: ['c1'],
      });
      mockApplyIntegrationDecisions.mockResolvedValue({
        updated: false,
        fields: [],
        rejected: [{ field: 'rules', reason: 'page is trashed or no longer exists' }],
      });

      const { POST } = await import('../route');
      await POST(createSignedCronRequest());

      assert({
        given: 'a cited candidate whose field write was blocked',
        should: 'settle it neither way, so the next run retries',
        actual: {
          promoted: mockMarkCandidatesPromoted.mock.calls[0]?.[0],
          rejected: mockMarkCandidatesRejected.mock.calls[0]?.[0],
        },
        expected: { promoted: [], rejected: [] },
      });
    });

    it('evaluates pending candidates even when discovery found nothing', async () => {
      // A candidate left pending by an earlier guard rejection is already
      // corroborated. Returning early on empty discovery stranded it until an
      // unrelated future run happened to discover at least one claim.
      mockRunDiscoveryPasses.mockResolvedValue({ claims: [] });
      mockFindPromotableCandidates.mockResolvedValue([candidate('c1')]);
      mockEvaluateAndIntegrate.mockResolvedValue({
        ok: true,
        updates: { rules: 'x' },
        usedCandidateIds: ['c1'],
      });
      mockApplyIntegrationDecisions.mockResolvedValue({
        updated: true,
        fields: ['rules'],
        rejected: [],
      });

      const { POST } = await import('../route');
      await POST(createSignedCronRequest());

      assert({
        given: 'a quiet week with a pending corroborated candidate',
        should: 'still evaluate and promote it',
        actual: {
          evaluated: mockEvaluateAndIntegrate.mock.calls.length,
          promoted: mockMarkCandidatesPromoted.mock.calls[0]?.[0],
        },
        expected: { evaluated: 1, promoted: ['c1'] },
      });
    });

    it('runs retention even when there is nothing to promote', async () => {
      // Forgetting must not be conditional on the happy path, or the accounts
      // whose runs fail most are the least cleaned up.
      mockFindPromotableCandidates.mockResolvedValue([]);

      const { POST } = await import('../route');
      await POST(createSignedCronRequest());

      assert({
        given: 'a run with no promotable candidates',
        should: 'still prune stale rows and redact settled evidence',
        actual: {
          pruned: mockPruneStaleCandidates.mock.calls.length,
          redacted: mockRedactSettledEvidence.mock.calls.length,
        },
        expected: { pruned: 1, redacted: 1 },
      });
    });
  });
});
