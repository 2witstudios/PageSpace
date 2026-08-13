import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

/**
 * Discovery Service Tests
 *
 * Discovery is "blind" — it never sees the current profile. Its output is a
 * flat list of claims, each tagged with the field it belongs to, so the caller
 * can stage them for corroboration.
 */

const mockDbSelect = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
  isNotNull: vi.fn(),
  ne: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId' },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  activityLogs: {
    operation: 'operation',
    resourceType: 'resourceType',
    resourceTitle: 'resourceTitle',
    userId: 'userId',
    driveId: 'driveId',
    timestamp: 'timestamp',
  },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { userId: 'userId', driveId: 'driveId', acceptedAt: 'acceptedAt' },
}));
vi.mock('@pagespace/db/schema/conversations', () => ({
  conversations: { id: 'id', type: 'type', userId: 'userId', contextId: 'contextId' },
  messages: {
    conversationId: 'conversationId',
    content: 'content',
    role: 'role',
    isActive: 'isActive',
    status: 'status',
    userId: 'userId',
    createdAt: 'createdAt',
    id: 'id',
  },
}));
vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn(async () => ({
    model: {},
    provider: 'anthropic',
    modelName: 'claude-sonnet-5',
  })),
  isProviderError: vi.fn(() => false),
}));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  BACKGROUND_HEAVY_PROVIDER: 'anthropic',
  BACKGROUND_HEAVY_MODEL: 'anthropic/claude-sonnet-5',
}));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn() },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

const mockGenerateObject = vi.fn();
vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => mockGenerateObject(...args),
}));

/**
 * Stand in for the two query shapes this module uses:
 *   message/activity reads  → .where().orderBy().limit()  (awaited at the end)
 *   drive-membership reads  → .where()                    (awaited directly)
 *
 * `where()` therefore has to be both thenable and chainable.
 */
function setupDb(messageRows: unknown[], driveRows: unknown[] = [{ driveId: 'drive-1' }]) {
  // The module runs three `.limit()` queries: global messages, page messages,
  // then activity. Serving `messageRows` to every one would silently duplicate
  // the transcript, which would make an index-resolution assertion meaningless.
  // So the rows are served ONCE and later queries come back empty.
  let served = false;
  mockDbSelect.mockImplementation(() => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      orderBy: () => chain,
      limit: () => {
        if (served) return Promise.resolve([]);
        served = true;
        return Promise.resolve(messageRows);
      },
      // Awaiting the chain directly resolves the drive-membership shape.
      where: () => Object.assign(Promise.resolve(driveRows), chain),
    };
    return chain;
  });
}

function messages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    content: `Message ${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    createdAt: new Date(Date.now() - i * 1000),
  }));
}

describe('runDiscoveryPasses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no claims when there is too little conversation to read', async () => {
    setupDb([]);
    const { runDiscoveryPasses } = await import('../discovery-service');

    const result = await runDiscoveryPasses('user-with-no-data');

    assert({
      given: 'a user with fewer than 3 messages',
      should: 'return no claims and not call the model at all',
      actual: { claims: result.claims, modelCalls: mockGenerateObject.mock.calls.length },
      expected: { claims: [], modelCalls: 0 },
    });
  });

  it('tags each claim with the field of the pass that produced it', async () => {
    setupDb(messages(10));
    // Every pass returns an untagged claim; the caller must assign the field so
    // a model that omits or misreports `field` cannot file a claim in the wrong page.
    mockGenerateObject.mockResolvedValue({
      object: { claims: [{ claim: 'c', evidence: 'e', occurrencesInWindow: 2 }] },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const { runDiscoveryPasses } = await import('../discovery-service');
    const result = await runDiscoveryPasses('user-with-data');

    assert({
      given: 'three passes each returning one claim',
      should: 'tag them bio, writingStyle, and rules respectively',
      actual: result.claims.map((c) => c.field).sort(),
      expected: ['bio', 'rules', 'writingStyle'],
    });
  });

  it('overrides a field the model reported incorrectly', async () => {
    setupDb(messages(10));
    // The bio pass returns a claim self-labelled as `rules`. The pass it came
    // from is the authority, not the model's own tag.
    mockGenerateObject.mockResolvedValue({
      object: {
        claims: [{ field: 'rules', claim: 'c', evidence: 'e', occurrencesInWindow: 2 }],
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const { runDiscoveryPasses } = await import('../discovery-service');
    const result = await runDiscoveryPasses('user-with-data');

    assert({
      given: 'every pass mislabelling its claim as "rules"',
      should: 'still produce one claim per field, from the pass of origin',
      actual: result.claims.map((c) => c.field).sort(),
      expected: ['bio', 'rules', 'writingStyle'],
    });
  });

  it('carries evidence through so claims can be corroborated', async () => {
    setupDb(messages(10));
    mockGenerateObject.mockResolvedValue({
      object: {
        claims: [
          { claim: 'Be concise', evidence: 'keep it short', occurrencesInWindow: 3 },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const { runDiscoveryPasses } = await import('../discovery-service');
    const result = await runDiscoveryPasses('user-with-data');

    assert({
      given: 'a model response with evidence and an occurrence count',
      should: 'preserve both on the returned claim',
      actual: {
        evidence: result.claims[0].evidence,
        occurrencesInWindow: result.claims[0].occurrencesInWindow,
      },
      expected: { evidence: 'keep it short', occurrencesInWindow: 3 },
    });
  });

  it('resolves a cited message index against a chronological transcript', async () => {
    // The db returns newest-first (that is how the most recent N are picked),
    // so the transcript must be reversed before numbering. Numbering it
    // newest-first would make [0] the newest while a model reading a
    // conversation assumes ascending time — "cite the most recent message"
    // would then return a HIGH index and resolve to the OLDEST message.
    //
    // The failure is silent: the index is in range, so the out-of-range
    // fallback never fires, and today's evidence is stamped a week old —
    // inverting the corroboration rule, which keys entirely on evidenceAt.
    const newest = new Date('2026-03-12T00:00:00.000Z');
    const oldest = new Date('2026-03-05T00:00:00.000Z');
    setupDb([
      { content: 'newest', role: 'user', createdAt: newest },
      { content: 'middle', role: 'user', createdAt: new Date('2026-03-08T00:00:00.000Z') },
      { content: 'oldest', role: 'user', createdAt: oldest },
    ]);

    // Cite the highest index — what a model means by "the most recent message".
    mockGenerateObject.mockResolvedValue({
      object: {
        claims: [
          { claim: 'c', evidence: 'e', occurrencesInWindow: 1, evidenceMessageIndex: 2 },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const { runDiscoveryPasses } = await import('../discovery-service');
    const result = await runDiscoveryPasses('user-1');

    assert({
      given: 'a claim citing the highest message number',
      should: 'date it from the NEWEST message, not the oldest',
      actual: result.claims[0]?.evidenceAt,
      expected: newest,
    });
  });

  it('dates a claim from the oldest message when the cited index is unusable', async () => {
    const oldest = new Date('2026-03-05T00:00:00.000Z');
    setupDb([
      { content: 'newest', role: 'user', createdAt: new Date('2026-03-12T00:00:00.000Z') },
      { content: 'middle', role: 'user', createdAt: new Date('2026-03-08T00:00:00.000Z') },
      { content: 'oldest', role: 'user', createdAt: oldest },
    ]);

    mockGenerateObject.mockResolvedValue({
      object: {
        claims: [
          { claim: 'c', evidence: 'e', occurrencesInWindow: 1, evidenceMessageIndex: 999 },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const { runDiscoveryPasses } = await import('../discovery-service');
    const result = await runDiscoveryPasses('user-1');

    assert({
      given: 'an out-of-range message index',
      should: 'fall back to the oldest message, so a claim can never look fresher than its evidence',
      actual: result.claims[0]?.evidenceAt,
      expected: oldest,
    });
  });

  it('degrades to no claims when a pass throws', async () => {
    setupDb(messages(10));
    mockGenerateObject.mockRejectedValue(new Error('LLM error'));

    const { runDiscoveryPasses } = await import('../discovery-service');
    const result = await runDiscoveryPasses('user-with-error');

    assert({
      given: 'every discovery pass failing',
      should: 'return no claims rather than throwing',
      actual: result.claims,
      expected: [],
    });
  });
});
