import { describe, it, expect, vi } from 'vitest';
import { resolveVoiceSpend, voiceContextRef, type VoiceSpendDeps } from '../voice-spend';
import type { SeedConversation } from '../binding-loader';

const row = (over: Partial<SeedConversation> = {}): SeedConversation => ({
  userId: 'u1',
  isShared: false,
  type: 'page',
  contextId: 'agent1',
  isActive: true,
  ...over,
});

function deps(over: Partial<VoiceSpendDeps> = {}): VoiceSpendDeps {
  return {
    loadConversation: vi.fn(async () => row()),
    canAccess: vi.fn(async () => true),
    loadPage: vi.fn(async (pageId: string) => ({ id: pageId, type: 'AI_CHAT', driveId: 'drive-1' })),
    canViewPage: vi.fn(async () => true),
    ...over,
  };
}

describe('resolveVoiceSpend — where a voice call spends, decided before it connects', () => {
  it('SPEND-1 (partial) a page agent\'s conversation spends in that page\'s drive', async () => {
    const d = deps();
    expect(await resolveVoiceSpend(d, { userId: 'u1', conversationId: 'conv1' })).toEqual({ kind: 'drive', driveId: 'drive-1' });
    expect(d.loadPage).toHaveBeenCalledWith('agent1');
  });

  it('SPEND-1 (partial) a page conversation whose page is not an agent still spends in its page\'s drive, as a typed turn there does', async () => {
    const d = deps({ loadPage: vi.fn(async () => ({ id: 'doc1', type: 'DOCUMENT', driveId: 'drive-2' })) });
    expect(await resolveVoiceSpend(d, { userId: 'u1', conversationId: 'conv1' })).toEqual({ kind: 'drive', driveId: 'drive-2' });
  });

  it('SPEND-4 (partial) a fresh page-agent thread (no row yet) spends in the drive of the agent page the caller can view — never personal credits by default', async () => {
    const d = deps({ loadConversation: vi.fn(async () => undefined) });
    expect(await resolveVoiceSpend(d, { userId: 'u1', conversationId: 'fresh', agentPageId: 'agent1' })).toEqual({ kind: 'drive', driveId: 'drive-1' });
    expect(d.canViewPage).toHaveBeenCalledWith('agent1');
  });

  it('SPEND-4 (partial) a fresh thread naming an agent page the caller cannot view is refused with a named reason, never charged to them', async () => {
    const d = deps({ loadConversation: vi.fn(async () => undefined), canViewPage: vi.fn(async () => false) });
    expect(await resolveVoiceSpend(d, { userId: 'u1', conversationId: 'fresh', agentPageId: 'agent1' })).toEqual({ kind: 'refused', reason: 'voice_spend_unresolved' });
    expect(d.loadPage).not.toHaveBeenCalled();
  });

  it('a fresh thread naming a page that is not an agent is refused, not billed personally', async () => {
    const d = deps({ loadConversation: vi.fn(async () => undefined), loadPage: vi.fn(async () => ({ id: 'doc1', type: 'DOCUMENT', driveId: 'drive-2' })) });
    expect(await resolveVoiceSpend(d, { userId: 'u1', conversationId: 'fresh', agentPageId: 'doc1' })).toEqual({ kind: 'refused', reason: 'voice_spend_unresolved' });
  });

  it('SPEND-4 (partial) a page conversation whose page cannot be read is refused, not billed personally', async () => {
    expect(await resolveVoiceSpend(deps({ loadPage: vi.fn(async () => undefined) }), { userId: 'u1', conversationId: 'conv1' }))
      .toEqual({ kind: 'refused', reason: 'voice_spend_unresolved' });
    expect(await resolveVoiceSpend(deps({ loadPage: vi.fn(async () => { throw new Error('db down'); }) }), { userId: 'u1', conversationId: 'conv1' }))
      .toEqual({ kind: 'refused', reason: 'voice_spend_unresolved' });
  });

  it('SPEND-4 (partial) a conversation read that fails resolves from the named agent page when there is one, and is refused when there is not', async () => {
    const failing = { loadConversation: vi.fn(async () => { throw new Error('db down'); }) };
    expect(await resolveVoiceSpend(deps(failing), { userId: 'u1', conversationId: 'conv1', agentPageId: 'agent1' })).toEqual({ kind: 'drive', driveId: 'drive-1' });
    expect(await resolveVoiceSpend(deps(failing), { userId: 'u1', conversationId: 'conv1' })).toEqual({ kind: 'refused', reason: 'voice_spend_unresolved' });
  });

  it('the conversation row wins over the named agent page: a caller cannot move a known thread\'s spend', async () => {
    const d = deps();
    expect(await resolveVoiceSpend(d, { userId: 'u1', conversationId: 'conv1', agentPageId: 'someone-elses-agent' })).toEqual({ kind: 'drive', driveId: 'drive-1' });
    expect(d.loadPage).toHaveBeenCalledWith('agent1');
    expect(d.canViewPage).not.toHaveBeenCalled();
  });

  it('a conversation the caller cannot read is refused with a named reason; nothing about it is read', async () => {
    const d = deps({ canAccess: vi.fn(async () => false) });
    expect(await resolveVoiceSpend(d, { userId: 'intruder', conversationId: 'conv1' })).toEqual({ kind: 'refused', reason: 'voice_conversation_forbidden' });
    expect(d.loadPage).not.toHaveBeenCalled();
  });

  it('SPEND-8 (partial) a Global Assistant conversation spends personal credits', async () => {
    expect(await resolveVoiceSpend(deps({ loadConversation: vi.fn(async () => row({ type: 'global', contextId: null })) }), { userId: 'u1', conversationId: 'conv1' }))
      .toEqual({ kind: 'personal' });
  });

  it('SPEND-8 (partial) a fresh Global Assistant thread (no row, no agent page) and an unbound call spend personal credits', async () => {
    expect(await resolveVoiceSpend(deps({ loadConversation: vi.fn(async () => undefined) }), { userId: 'u1', conversationId: 'fresh' })).toEqual({ kind: 'personal' });
    expect(await resolveVoiceSpend(deps(), { userId: 'u1' })).toEqual({ kind: 'personal' });
  });

  it('SPEND-1 (partial) a Global Assistant conversation held inside a drive spends in that drive, as its typed turn there does (the drive the server resolved from the caller\'s context)', async () => {
    expect(await resolveVoiceSpend(deps({ loadConversation: vi.fn(async () => row({ type: 'global', contextId: null })) }), { userId: 'u1', conversationId: 'conv1', contextDriveId: 'drive-7' }))
      .toEqual({ kind: 'drive', driveId: 'drive-7' });
  });

  it('SPEND-1 (partial) a fresh Global Assistant thread and an unbound call inside a drive spend in that drive, never personal credits', async () => {
    expect(await resolveVoiceSpend(deps({ loadConversation: vi.fn(async () => undefined) }), { userId: 'u1', conversationId: 'fresh', contextDriveId: 'drive-7' }))
      .toEqual({ kind: 'drive', driveId: 'drive-7' });
    expect(await resolveVoiceSpend(deps(), { userId: 'u1', contextDriveId: 'drive-7' })).toEqual({ kind: 'drive', driveId: 'drive-7' });
  });

  it('a page or drive conversation keeps its own drive whatever context the caller stands in: the context only places a call that has no drive of its own', async () => {
    expect(await resolveVoiceSpend(deps(), { userId: 'u1', conversationId: 'conv1', contextDriveId: 'drive-7' })).toEqual({ kind: 'drive', driveId: 'drive-1' });
    expect(await resolveVoiceSpend(deps({ loadConversation: vi.fn(async () => row({ type: 'drive', contextId: 'drive-9' })) }), { userId: 'u1', conversationId: 'conv1', contextDriveId: 'drive-7' }))
      .toEqual({ kind: 'drive', driveId: 'drive-9' });
  });

  it('a drive conversation spends in its drive', async () => {
    expect(await resolveVoiceSpend(deps({ loadConversation: vi.fn(async () => row({ type: 'drive', contextId: 'drive-9' })) }), { userId: 'u1', conversationId: 'conv1' }))
      .toEqual({ kind: 'drive', driveId: 'drive-9' });
  });
});

describe('voiceContextRef — the reference the server resolves a voice call\'s context from', () => {
  it('names the page the caller stands on, else their drive, else nothing — a claim the server permission-checks, never a drive it trusts', () => {
    const page = { id: 'p1', title: 'Plan', type: 'DOCUMENT', path: '/d/p1' };
    const drive = { id: 'd1', name: 'Product', slug: 'product' };
    expect(voiceContextRef({ currentPage: page, currentDrive: drive })).toEqual({ routeType: 'page', pageId: 'p1' });
    expect(voiceContextRef({ currentDrive: drive })).toEqual({ routeType: 'drive', driveId: 'd1' });
    expect(voiceContextRef({})).toBeUndefined();
    expect(voiceContextRef(undefined)).toBeUndefined();
  });
});
