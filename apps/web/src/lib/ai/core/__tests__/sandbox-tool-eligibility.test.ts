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

vi.mock('@pagespace/lib/services/agent-workspaces/agent-workspace-tenant', () => ({
  canRunCodeForSession: mockCanRunCodeForSession,
}));
vi.mock('@/lib/agent-workspaces/agent-workspaces-runtime', () => ({
  findSessionForConversation: mockFindSessionForConversation,
}));

import {
  resolveSandboxToolEligibility,
  resolveSandboxToolEligibilityForConversation,
} from '../sandbox-tool-eligibility';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';

const ACTOR = credentialActor('actor-1', null);

describe('resolveSandboxToolEligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the requester as BOTH actor and (driveless-fallback) owner, with the surface drive', async () => {
    mockCanRunCodeForSession.mockResolvedValue(true);
    const result = await resolveSandboxToolEligibility('drive-1', ACTOR);
    expect(result).toBe(true);
    expect(mockCanRunCodeForSession).toHaveBeenCalledWith({ actor: expect.objectContaining({ userId: 'actor-1' }), driveId: 'drive-1', ownerId: 'actor-1' });
  });

  it('propagates a capability denial (viewer role, free payer, or kill switch — one gate, all legs)', async () => {
    mockCanRunCodeForSession.mockResolvedValue(false);
    await expect(resolveSandboxToolEligibility(null, ACTOR)).resolves.toBe(false);
  });
});

describe('resolveSandboxToolEligibilityForConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a BOUND conversation authorizes the requester against the session coordinates, whatever the surface', async () => {
    mockFindSessionForConversation.mockResolvedValue({ id: 'ses-1', driveId: 'session-drive', ownerId: 'session-owner' });
    mockCanRunCodeForSession.mockResolvedValue(true);
    const result = await resolveSandboxToolEligibilityForConversation('conv-1', 'page', ACTOR);
    expect(result).toBe(true);
    expect(mockCanRunCodeForSession).toHaveBeenCalledWith({ actor: expect.objectContaining({ userId: 'actor-1' }), driveId: 'session-drive', ownerId: 'session-owner' });
  });

  it('an UNBOUND PAGE conversation is never eligible — acquire answers no_session for it (codex round 14)', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockCanRunCodeForSession.mockResolvedValue(true);
    const result = await resolveSandboxToolEligibilityForConversation('conv-2', 'page', ACTOR);
    expect(result).toBe(false);
    // The capability is not even consulted: no session can exist to act in.
    expect(mockCanRunCodeForSession).not.toHaveBeenCalled();
  });

  it('an UNBOUND GLOBAL conversation uses the driveless auto-provision coordinates with the requester as owner', async () => {
    mockFindSessionForConversation.mockResolvedValue(null);
    mockCanRunCodeForSession.mockResolvedValue(true);
    await resolveSandboxToolEligibilityForConversation('conv-3', 'global', ACTOR);
    expect(mockCanRunCodeForSession).toHaveBeenCalledWith({ actor: expect.objectContaining({ userId: 'actor-1' }), driveId: null, ownerId: 'actor-1' });
  });

  it('no conversation id skips the session lookup entirely (global surface)', async () => {
    mockCanRunCodeForSession.mockResolvedValue(false);
    await resolveSandboxToolEligibilityForConversation(undefined, 'global', ACTOR);
    expect(mockFindSessionForConversation).not.toHaveBeenCalled();
    expect(mockCanRunCodeForSession).toHaveBeenCalledWith({ actor: expect.objectContaining({ userId: 'actor-1' }), driveId: null, ownerId: 'actor-1' });
  });

  it('no conversation id on a PAGE surface is not eligible without any lookups', async () => {
    const result = await resolveSandboxToolEligibilityForConversation(undefined, 'page', ACTOR);
    expect(result).toBe(false);
    expect(mockFindSessionForConversation).not.toHaveBeenCalled();
    expect(mockCanRunCodeForSession).not.toHaveBeenCalled();
  });
});
