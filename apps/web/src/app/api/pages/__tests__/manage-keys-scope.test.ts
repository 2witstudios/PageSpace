/**
 * Red-team test: a manage-keys-only OAuth credential (Phase 9, mintable today
 * via the manage_keys scope token — see ScopeSet.manageKeys) must not be able
 * to create a page. Uses the REAL checkMCPCreateScope/isManageKeysOnly
 * implementation (not mocked) so this fails if the hardening in
 * apps/web/src/lib/auth/index.ts regresses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { POST } from '../route';
import { manageKeysScopedAuthResult } from '@/lib/auth/__tests__/manage-keys-fixture';

vi.mock('@/services/api', () => ({
  pageService: { createPage: vi.fn() },
}));

vi.mock('@/lib/websocket', () => ({
  broadcastPageEvent: vi.fn(),
  createPageEventPayload: vi.fn((driveId, pageId, type, data) => ({ driveId, pageId, type, ...data })),
}));

vi.mock('@/lib/ai/core/ai-tools', () => ({
  pageSpaceTools: {
    read_page: { description: 'Read a page' },
    create_drive: { description: 'Create a drive' },
  },
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
vi.mock('@pagespace/lib/monitoring/activity-logger', () => ({
  getActorInfo: vi.fn().mockResolvedValue({ actorEmail: 'test@example.com', actorDisplayName: 'Test User' }),
  logPageActivity: vi.fn(),
}));
vi.mock('@pagespace/lib/content/page-types.config', () => ({
  getCreatablePageTypes: vi.fn(() => ['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'SHEET', 'TASK_LIST', 'CODE']),
}));
vi.mock('@pagespace/lib/monitoring/activity-tracker', () => ({
  trackPageOperation: vi.fn(),
}));

// Only stub authentication — checkMCPCreateScope and isManageKeysOnly run for real.
vi.mock('@/lib/auth/request-auth', async (importOriginal) => ({
  ...(await importOriginal()),
  authenticateRequestWithOptions: vi.fn(),
}));
import { pageService } from '@/services/api';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';

describe('POST /api/pages — manage-keys-only credential', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(manageKeysScopedAuthResult());
  });

  it('denies page creation with 403 instead of the empty-allowedDriveIds full-access default', async () => {
    const request = new Request('https://example.com/api/pages', {
      method: 'POST',
      body: JSON.stringify({ title: 'Should Not Be Created', type: 'DOCUMENT', driveId: 'drive-owned-by-token-user' }),
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
    expect(pageService.createPage).not.toHaveBeenCalled();
  });
});
