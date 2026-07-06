/**
 * Red-team test: a manage-keys-only OAuth credential (Phase 9, not yet
 * reachable via any real request — see ScopeSet.manageKeys) must not be able
 * to create a drive. Uses the REAL checkMCPCreateScope/isManageKeysOnly
 * implementation (not mocked) so this fails if the hardening in
 * apps/web/src/lib/auth/index.ts regresses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../route';
import { manageKeysScopedAuthResult } from '@/lib/auth/__tests__/manage-keys-fixture';

vi.mock('@pagespace/lib/services/drive-service', () => ({
  listAccessibleDrives: vi.fn(),
  createDrive: vi.fn(),
}));
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  audit: vi.fn(),
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackDriveOperation: vi.fn(),
}));
vi.mock('@pagespace/lib/utils/api-utils', () => ({
  jsonResponse: vi.fn((data, options = {}) => Response.json(data, { status: options.status || 200 })),
}));
vi.mock('@/lib/websocket', () => ({
  broadcastDriveEvent: vi.fn().mockResolvedValue(undefined),
  createDriveEventPayload: vi.fn((driveId, event, data) => ({ driveId, event, data })),
}));
vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppDriveMembership: vi.fn(),
}));

// Only stub authentication — checkMCPCreateScope and isManageKeysOnly run for real.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    authenticateRequestWithOptions: vi.fn(),
  };
});

import { authenticateRequestWithOptions } from '@/lib/auth';
import { createDrive } from '@pagespace/lib/services/drive-service';

describe('POST /api/drives — manage-keys-only credential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());
  });

  it('denies drive creation with 403 instead of the empty-allowedDriveIds full-access default', async () => {
    const request = new Request('https://example.com/api/drives', {
      method: 'POST',
      body: JSON.stringify({ name: 'Should Not Be Created' }),
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(createDrive).not.toHaveBeenCalled();
  });
});
