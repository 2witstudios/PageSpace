import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * PII decryption coverage for the audit-logs CSV export stream.
 *
 * activityLogs.actorEmail/actorDisplayName are denormalized actor snapshots,
 * distinct from the joined users.name/users.email columns. A ~4-hour
 * production gap (before the actor-info decrypt-before-write fix landed)
 * could have written raw ciphertext into these two columns for
 * `code_execution` rows, and there is no backfill for `activityLogs`. The
 * export route must decrypt actorEmail/actorDisplayName the same
 * plaintext-safe way it already decrypts the joined userName/userEmail
 * columns, so any surviving ciphertext never reaches the CSV.
 */

const { mockVerifyAdminAuth } = vi.hoisted(() => ({
  mockVerifyAdminAuth: vi.fn(),
}));

vi.mock('@/lib/auth/auth', () => ({
  verifyAdminAuth: mockVerifyAdminAuth,
  isAdminAuthError: (result: unknown) => result instanceof Response,
  withAdminAuth: <T>(handler: (user: unknown, request: Request, context: T) => Promise<Response>) => {
    return async (request: Request, context: T): Promise<Response> => {
      const resolved = await mockVerifyAdminAuth(request);
      if (resolved instanceof Response) return resolved;
      return handler(resolved, request, context);
    };
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    security: { warn: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

// Wrap (not replace) the real decryptFieldValuesOnce so batching can be
// asserted at the route's call boundary, matching the pattern used for the
// sibling non-export audit-logs route's PII-decrypt coverage.
vi.mock('@pagespace/lib/encryption/field-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pagespace/lib/encryption/field-crypto')>();
  return { ...actual, decryptFieldValuesOnce: vi.fn(actual.decryptFieldValuesOnce) };
});

const { fixtureRows } = vi.hoisted(() => ({
  fixtureRows: [] as Record<string, unknown>[],
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        leftJoin: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                offset: (n: number) => Promise.resolve(n === 0 ? fixtureRows : []),
              }),
            }),
          }),
        }),
      }),
    }),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ type: 'eq', col, val })),
  and: vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
  desc: vi.fn((col: unknown) => ({ type: 'desc', col })),
  gte: vi.fn((col: unknown, val: unknown) => ({ type: 'gte', col, val })),
  lte: vi.fn((col: unknown, val: unknown) => ({ type: 'lte', col, val })),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ type: 'sql', strings, values }),
    {},
  ),
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', name: 'name', email: 'email' },
}));

vi.mock('@pagespace/db/schema/monitoring', () => ({
  activityLogs: {
    id: 'id',
    timestamp: 'timestamp',
    userId: 'userId',
    actorEmail: 'actorEmail',
    actorDisplayName: 'actorDisplayName',
    isAiGenerated: 'isAiGenerated',
    aiProvider: 'aiProvider',
    aiModel: 'aiModel',
    aiConversationId: 'aiConversationId',
    operation: { enumValues: ['create', 'update', 'delete', 'code_execution'] },
    resourceType: { enumValues: ['page', 'drive', 'user'] },
    resourceId: 'resourceId',
    resourceTitle: 'resourceTitle',
    driveId: 'driveId',
    pageId: 'pageId',
    updatedFields: 'updatedFields',
    previousValues: 'previousValues',
    newValues: 'newValues',
    metadata: 'metadata',
    isArchived: 'isArchived',
    previousLogHash: 'previousLogHash',
    logHash: 'logHash',
    chainSeed: 'chainSeed',
  },
}));

import { GET } from '../route';
import { decryptFieldValuesOnce, encryptField } from '@pagespace/lib/encryption/field-crypto';

const mockAdminUser = {
  id: 'admin-user-id',
  role: 'admin' as const,
  tokenVersion: 1,
  adminRoleVersion: 1,
};

async function readAllText(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe('GET /api/admin/audit-logs/export — actor snapshot PII decryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyAdminAuth.mockResolvedValue(mockAdminUser);
    fixtureRows.length = 0;
  });

  it('decrypts a ciphertext actorEmail/actorDisplayName snapshot before writing the CSV row', async () => {
    // Simulates a `code_execution` row written during the historical gap
    // where the realtime writer stored the raw actor snapshot pre-encrypt.
    const encryptedEmail = await encryptField('actor@example.com');
    const encryptedName = await encryptField('Real Actor');

    fixtureRows.push({
      id: 'log-1',
      timestamp: new Date('2024-01-10T00:00:00.000Z'),
      userId: 'user-1',
      actorEmail: encryptedEmail,
      actorDisplayName: encryptedName,
      isAiGenerated: false,
      aiProvider: null,
      aiModel: null,
      aiConversationId: null,
      operation: 'code_execution',
      resourceType: 'page',
      resourceId: 'res-1',
      resourceTitle: 'Some Page',
      driveId: 'drive-1',
      pageId: 'page-1',
      updatedFields: null,
      previousValues: null,
      newValues: null,
      metadata: null,
      isArchived: false,
      previousLogHash: null,
      logHash: 'hash-1',
      chainSeed: null,
      userName: null,
      userEmail: null,
    });

    const request = new Request('http://localhost/api/admin/audit-logs/export', { method: 'GET' });
    const response = await GET(request);
    const csv = await readAllText(response);

    const [headerLine, dataLine] = csv.trim().split('\n');
    const headers = headerLine.split(',');
    const cells = dataLine.split(',');
    const actorEmailIdx = headers.indexOf('actorEmail');
    const actorDisplayNameIdx = headers.indexOf('actorDisplayName');

    // The raw ciphertext must never reach the exported CSV row.
    expect(cells[actorEmailIdx]).toBe('actor@example.com');
    expect(cells[actorDisplayNameIdx]).toBe('Real Actor');
    expect(cells[actorEmailIdx]).not.toBe(encryptedEmail);
    expect(cells[actorDisplayNameIdx]).not.toBe(encryptedName);
  });

  it('batches actorEmail/actorDisplayName decryption together with userEmail/userName per page', async () => {
    const encryptedEmail = await encryptField('shared-actor@example.com');
    const encryptedName = await encryptField('Shared Actor');

    fixtureRows.push(
      {
        id: 'log-1',
        timestamp: new Date('2024-01-10T00:00:00.000Z'),
        userId: 'user-1',
        actorEmail: encryptedEmail,
        actorDisplayName: encryptedName,
        isAiGenerated: false,
        aiProvider: null,
        aiModel: null,
        aiConversationId: null,
        operation: 'code_execution',
        resourceType: 'page',
        resourceId: 'res-1',
        resourceTitle: 'Some Page',
        driveId: 'drive-1',
        pageId: 'page-1',
        updatedFields: null,
        previousValues: null,
        newValues: null,
        metadata: null,
        isArchived: false,
        previousLogHash: null,
        logHash: 'hash-1',
        chainSeed: null,
        userName: encryptedName,
        userEmail: encryptedEmail,
      },
    );

    const request = new Request('http://localhost/api/admin/audit-logs/export', { method: 'GET' });
    const response = await GET(request);
    await readAllText(response);

    // Same repeated ciphertext across the joined and snapshot columns should
    // be included in the same batched decrypt call (dedup handles repeats),
    // not one decryptField call per row/column.
    const emailBatch = vi
      .mocked(decryptFieldValuesOnce)
      .mock.calls.filter(([values]) => values.includes(encryptedEmail));
    const nameBatch = vi
      .mocked(decryptFieldValuesOnce)
      .mock.calls.filter(([values]) => values.includes(encryptedName));

    expect(emailBatch).toHaveLength(1);
    expect(emailBatch[0][0].filter((v) => v === encryptedEmail)).toHaveLength(2);
    expect(nameBatch).toHaveLength(1);
    expect(nameBatch[0][0].filter((v) => v === encryptedName)).toHaveLength(2);
  });
});
