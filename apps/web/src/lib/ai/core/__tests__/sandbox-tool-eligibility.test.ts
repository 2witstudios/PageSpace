import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Exposure eligibility delegates to the CENTRALIZED actor-aware capability
// (canRunCodeForSession → canRunCode: kill switch + payer tier + the
// requester's drive edit access), with the bound session's coordinates when
// the conversation has one (review #2326, codex round 9). These tests pin the
// coordinate plumbing — the capability's own legs are tested where it lives.
// ============================================================================

const { mockCanRunCodeForSession, mockFindSessionForConversation } = vi.hoisted(() => ({
  mockCanRunCodeForSession: vi.fn(),
  mockFindSessionForConversation: vi.fn(),
}));

vi.mock('@pagespace/lib/services/agent-sessions/agent-session-tenant', () => ({
  canRunCodeForSession: mockCanRunCodeForSession,
}));
vi.mock('@/lib/agent-sessions/agent-sessions-runtime', () => ({
  findSessionForConversation: mockFindSessionForConversation,
}));

import {
  resolveSandboxToolEligibility,
  resolveSandboxToolEligibilityForConversation,
} from '../sandbox-tool-eligibility';

describe('resolveSandboxToolEligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the requester as BOTH actor and (driveless-fallback) owner, with the surface drive', async () => {
    mockCanRunCodeForSession.mockResolvedValue(true);
    const result = await resolveSandboxToolEligibility('drive-1', 'actor-1');
    expect(result).toBe(true);
    expect(mockCanRunCodeForSession).toHaveBeenCalledWith({ userId: 'actor-1', driveId: 'drive-1', ownerId: 'actor-1' });
  });

  it('propagates a capability denial (viewer role, free payer, or kill switch — one gate, all legs)', async () => {
    mockCanRunCodeForSession.mockResolvedValue(false);
    await expect(resolveSandboxToolEligibility(null, 'actor-1')).resolves.toBe(false);
  });
});

describe('resolveSandboxToolEligibilityForConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a BOUND conversation authorizes the requester against the session coordinates, not the surface drive', async () => {
    mockFindSessionForConversation.mockResolvedValue({ id: 'ses-1', driveId: 'session-drive', ownerId: 'session-owner' });
    mockCanRunCodeForSession.mockResolvedValue(true);
    const result = await resolveSandboxToolEligibilityForConversation('conv-1', 'surface-drive', 'actor-1');
    expect(result).toBe(true);
    expect(mockCanRunCodeForSession).toHaveBeenCalledWith({ userId: 'actor-1', driveId: 'session-drive', ownerId: 'session-owner' });
  });

  it('an UNBOUND conversation falls back to the surface coordinates with the requester as owner', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockCanRunCodeForSession.mockResolvedValue(true);
    await resolveSandboxToolEligibilityForConversation('conv-2', 'surface-drive', 'actor-1');
    expect(mockCanRunCodeForSession).toHaveBeenCalledWith({ userId: 'actor-1', driveId: 'surface-drive', ownerId: 'actor-1' });
  });

  it('no conversation id skips the session lookup entirely', async () => {
    mockCanRunCodeForSession.mockResolvedValue(false);
    await resolveSandboxToolEligibilityForConversation(undefined, null, 'actor-1');
    expect(mockFindSessionForConversation).not.toHaveBeenCalled();
    expect(mockCanRunCodeForSession).toHaveBeenCalledWith({ userId: 'actor-1', driveId: null, ownerId: 'actor-1' });
  });
});
