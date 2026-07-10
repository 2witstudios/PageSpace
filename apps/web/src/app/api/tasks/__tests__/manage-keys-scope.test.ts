/**
 * Red-team test: a manage-keys-only OAuth credential (Phase 9, mintable today
 * via the manage_keys scope token — see ScopeSet.manageKeys) must not be able
 * to list tasks in a drive. Uses the REAL checkMCPDriveScope/isManageKeysOnly
 * implementation (not mocked). isPrincipalDriveMember is stubbed to `true` —
 * simulating a hypothetical bypass of that separate membership check — so
 * this test isolates and proves checkMCPDriveScope independently fails
 * closed rather than relying on the other layer to catch it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { manageKeysScopedAuthResult } from '@/lib/auth/__tests__/manage-keys-fixture';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pages: { findMany: vi.fn() },
      taskLists: { findMany: vi.fn() },
      taskItems: { findMany: vi.fn() },
      taskStatusConfigs: { findMany: vi.fn() },
    },
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn((...args: unknown[]) => args),
  desc: vi.fn(),
  count: vi.fn(),
  gte: vi.fn(),
  lt: vi.fn(),
  lte: vi.fn(),
  inArray: vi.fn(),
  or: vi.fn(),
  isNull: vi.fn(),
  not: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', type: 'type', isTrashed: 'isTrashed', title: 'title' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: { assigneeId: 'assigneeId', pageId: 'pageId', status: 'status', priority: 'priority', createdAt: 'createdAt', updatedAt: 'updatedAt', description: 'description' },
  taskLists: { id: 'id', pageId: 'pageId' },
  taskStatusConfigs: { taskListId: 'taskListId' },
}));
vi.mock('@/lib/task-status-config', () => ({
  DEFAULT_STATUS_CONFIG: {} as Record<string, { label: string; color: string; group: string }>,
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

// Only stub authentication + drive membership — checkMCPDriveScope and
// isManageKeysOnly run for real.
vi.mock('@/lib/auth/request-auth', async (importOriginal) => ({
  ...(await importOriginal()),
  authenticateRequestWithOptions: vi.fn(),
}));
vi.mock('@/lib/auth/principal-permissions', async (importOriginal) => ({
  ...(await importOriginal()),
  isPrincipalDriveMember: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isPrincipalDriveMember } from '@/lib/auth/principal-permissions';

describe('GET /api/tasks — manage-keys-only credential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());
    vi.mocked(isPrincipalDriveMember).mockResolvedValue(true);
  });

  it('denies drive-context task listing with 403 instead of the empty-allowedDriveIds full-access default', async () => {
    const request = new Request('https://example.com/api/tasks?context=drive&driveId=drive-1');

    const response = await GET(request);

    expect(response.status).toBe(403);
  });
});
