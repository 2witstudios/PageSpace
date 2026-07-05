import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SessionAuthResult } from '@/lib/auth';

// ============================================================================
// Contract tests for /api/ai/page-agents/[agentId]/drives/[driveId] (PATCH/DELETE)
// ============================================================================

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));
vi.mock('@pagespace/lib/services/drive-agent-service', () => ({
  removeAgentFromDrive: vi.fn(),
  setAgentDriveIncludeContext: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

import { PATCH } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { setAgentDriveIncludeContext } from '@pagespace/lib/services/drive-agent-service';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  role: 'user',
  adminRoleVersion: 0,
});

const MOCK_USER_ID = 'user_123';
const MOCK_DRIVE_ID = 'drive_abc';
const MOCK_AGENT_ID = 'agent_xyz';

const createContext = () => ({
  params: Promise.resolve({ agentId: MOCK_AGENT_ID, driveId: MOCK_DRIVE_ID }),
});

const patchRequest = (body: unknown) =>
  new Request('https://example.com/api/ai/page-agents/a/drives/d', { method: 'PATCH', body: JSON.stringify(body) });

describe('PATCH /api/ai/page-agents/[agentId]/drives/[driveId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(MOCK_USER_ID));
    vi.mocked(isAuthError).mockReturnValue(false);
  });

  it('delegates to setAgentDriveIncludeContext and returns the updated member', async () => {
    vi.mocked(setAgentDriveIncludeContext).mockResolvedValue({
      ok: true,
      member: { id: 'member_1', includeContext: true } as never,
    });

    const response = await PATCH(patchRequest({ includeContext: true }), createContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.member).toMatchObject({ includeContext: true });
    expect(setAgentDriveIncludeContext).toHaveBeenCalledWith({
      actingUserId: MOCK_USER_ID,
      agentPageId: MOCK_AGENT_ID,
      driveId: MOCK_DRIVE_ID,
      includeContext: true,
    });
  });

  it('surfaces the service failure status and error', async () => {
    vi.mocked(setAgentDriveIncludeContext).mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Home drive context is controlled by includeDrivePrompt, not this flag',
    });

    const response = await PATCH(patchRequest({ includeContext: true }), createContext());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('includeDrivePrompt');
  });

  it('400s on an invalid request body', async () => {
    const response = await PATCH(patchRequest({ includeContext: 'yes' }), createContext());
    expect(response.status).toBe(400);
    expect(setAgentDriveIncludeContext).not.toHaveBeenCalled();
  });
});
