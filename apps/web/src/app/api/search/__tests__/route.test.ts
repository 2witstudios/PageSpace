import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));
vi.mock('@/lib/auth', () => ({
  verifyAuth: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getBatchPagePermissions: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('@pagespace/lib/auth/user-repository', () => ({
  decryptUserRows: vi.fn((rows: unknown[]) => Promise.resolve(rows)),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { debug: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

import { db } from '@pagespace/db/db';
import { verifyAuth } from '@/lib/auth';
import * as dbOperators from '@pagespace/db/operators';
import { GET } from '../route';

// ============================================================================
// Contract test for /api/search — LIKE pattern escaping.
//
// This route has no other test coverage of its GET handler, so this is a
// minimal contract test rather than a full suite: it verifies the search
// term reaches ilike() escaped, not the full ranking/permission behavior.
// ============================================================================

describe('GET /api/search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyAuth).mockResolvedValue({ id: 'user_1' } as never);

    // Drizzle query builders are thenables — some call sites in the route
    // `await` the chain directly without a trailing `.limit()`, so `where()`
    // must resolve to an (empty) array on its own, not just return `this`.
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    chain.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
    vi.mocked(db.select).mockReturnValue(chain as never);
  });

  it('escapes LIKE metacharacters in the search term before building ilike conditions (regression: over-matching fix)', async () => {
    const ilikeSpy = vi.spyOn(dbOperators, 'ilike');

    // A search for "50% off" contains a literal '%' — if it reaches ilike()
    // unescaped, Postgres reads it as a wildcard instead of a literal character.
    const request = new Request(`https://example.com/api/search?q=${encodeURIComponent('50% off')}`);
    const response = await GET(request);

    expect(response.status).toBe(200);
    const patterns = ilikeSpy.mock.calls.map(([, pattern]) => pattern);
    expect(patterns).toContain('%50\\%%');
    expect(patterns).toContain('%off%');
  });
});
