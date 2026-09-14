/**
 * GET /api/commands lists the caller's personal commands and the drive commands
 * of drives it belongs to. An OAuth application's consent names drives, never
 * the user's personal commands (point-guard ruling), so for an OAuth principal
 * the personal half is left out of the query entirely. mcp_ keys and sessions
 * unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db/operators', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/db/operators')>()),
  eq: vi.fn((column: { name?: string }, value: unknown) => ({ op: 'eq', column: column?.name, value })),
  or: vi.fn((...clauses: unknown[]) => ({ op: 'or', clauses })),
  inArray: vi.fn((column: { name?: string }, values: unknown) => ({ op: 'inArray', column: column?.name, values })),
}));
vi.mock('@pagespace/db/db', () => {
  const chain = { from: () => chain, innerJoin: () => chain, where: async () => [{ id: 'drivex', driveId: 'drivex' }] };
  return {
    db: {
      select: vi.fn(() => chain),
      query: {
        commands: { findMany: vi.fn(async () => []) },
        pages: { findMany: vi.fn(async () => []) },
        users: { findMany: vi.fn(async () => []) },
      },
    },
  };
});
vi.mock('@pagespace/lib/audit/audit-log', () => ({ audit: vi.fn(), auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  logSecurityEvent: vi.fn(),
}));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, authenticateRequestWithOptions: vi.fn() };
});

import { GET } from '../route';
import { db } from '@pagespace/db/db';
import { authenticateRequestWithOptions, type AuthResult } from '@/lib/auth';
import { PARITY_USER_ID, mcpDriveKey, oauthDriveGrant } from '@/lib/auth/__tests__/oauth-principal-fixture';

const session: AuthResult = { tokenType: 'session', sessionId: 's', userId: PARITY_USER_ID, role: 'user', tokenVersion: 0, adminRoleVersion: 0 };
const list = () => GET(new Request('https://example.com/api/commands'));
const whereOfListing = () => JSON.stringify(vi.mocked(db.query.commands.findMany).mock.calls[0]?.[0]);

beforeEach(() => vi.clearAllMocks());

describe('GET /api/commands — personal commands and OAuth', () => {
  it("leaves the user's personal commands out of an OAuth grant's listing", async () => {
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(oauthDriveGrant('drivex', 'admin'));
    expect((await list()).status).toBe(200);
    expect(whereOfListing()).not.toContain('"column":"user_id"');
    expect(whereOfListing()).toContain('"column":"drive_id"');
  });

  for (const [label, principal] of [['a drive-scoped mcp_ key', mcpDriveKey('drivex')], ['a session', session]] as const) {
    it(`still lists personal commands to ${label}`, async () => {
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(principal);
      expect((await list()).status).toBe(200);
      expect(whereOfListing()).toContain('"column":"user_id"');
    });
  }
});
