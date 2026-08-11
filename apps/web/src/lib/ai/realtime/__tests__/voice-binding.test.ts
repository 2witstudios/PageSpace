import { describe, expect, it } from 'vitest';
import {
  isCallOnConversation,
  resolveVoiceBinding,
  type VoiceBindingFacts,
} from '../voice-binding';

/**
 * The rule under test is "there is no target picker" — every route has exactly
 * one answer, derived from what is on screen. The cases that matter are the
 * ones where a plausible implementation would get it wrong: crossing the two
 * surfaces' pairs, and treating an unresolved conversation as "voice is
 * unavailable" rather than "not yet".
 */

const facts = (overrides: Partial<VoiceBindingFacts> = {}): VoiceBindingFacts => ({
  isDashboardContext: false,
  dashboardAgent: null,
  dashboardConversationId: null,
  sidebarAgent: null,
  sidebarConversationId: null,
  globalConversationId: null,
  ...overrides,
});

describe('resolveVoiceBinding — which conversation the mic talks to', () => {
  it('should bind a page route to the SIDEBAR agent and the sidebar conversation', () => {
    const binding = resolveVoiceBinding(
      facts({
        sidebarAgent: { id: 'agent-sidebar' },
        sidebarConversationId: 'conv-sidebar',
        // Present and DIFFERENT, so a implementation reading the wrong pair
        // produces a visibly wrong answer instead of the same one by luck.
        dashboardAgent: { id: 'agent-dashboard' },
        dashboardConversationId: 'conv-dashboard',
      }),
    );

    expect(binding).toEqual({
      kind: 'ready',
      surface: 'sidebar',
      target: {
        conversationId: 'conv-sidebar',
        type: 'page',
        contextId: 'agent-sidebar',
        agentPageId: 'agent-sidebar',
      },
    });
  });

  it('should bind the dashboard to the DASHBOARD pair, where the sidebar has no chat tab', () => {
    const binding = resolveVoiceBinding(
      facts({
        isDashboardContext: true,
        sidebarAgent: { id: 'agent-sidebar' },
        sidebarConversationId: 'conv-sidebar',
        dashboardAgent: { id: 'agent-dashboard' },
        dashboardConversationId: 'conv-dashboard',
      }),
    );

    expect(binding).toEqual({
      kind: 'ready',
      surface: 'dashboard',
      target: {
        conversationId: 'conv-dashboard',
        type: 'page',
        contextId: 'agent-dashboard',
        agentPageId: 'agent-dashboard',
      },
    });
  });

  it('should NEVER cross the pairs — an agent from one surface with the other surface\'s conversation', () => {
    // The dashboard has an agent but no conversation yet; the sidebar has one
    // sitting right there. Taking it would open a call to the dashboard's agent
    // that writes its transcript into the sidebar agent's thread.
    const binding = resolveVoiceBinding(
      facts({
        isDashboardContext: true,
        dashboardAgent: { id: 'agent-dashboard' },
        dashboardConversationId: null,
        sidebarAgent: { id: 'agent-sidebar' },
        sidebarConversationId: 'conv-sidebar',
        globalConversationId: 'conv-global',
      }),
    );

    expect(binding).toEqual({ kind: 'resolving', surface: 'dashboard' });
  });

  it('should fall back to the ONE global conversation when no agent is selected, on either surface', () => {
    const onPage = resolveVoiceBinding(facts({ globalConversationId: 'conv-global' }));
    const onDashboard = resolveVoiceBinding(
      facts({ isDashboardContext: true, globalConversationId: 'conv-global' }),
    );

    expect(onPage).toEqual({
      kind: 'ready',
      surface: 'sidebar',
      target: { conversationId: 'conv-global', type: 'global' },
    });
    // Same conversation, different surface: the global assistant is one
    // assistant however you reach it.
    expect(onDashboard).toEqual({
      kind: 'ready',
      surface: 'dashboard',
      target: { conversationId: 'conv-global', type: 'global' },
    });
  });

  it('should report resolving — not unavailable — while a conversation id is in flight', () => {
    // What `selectAgent` leaves behind for a moment: an agent, no conversation.
    expect(
      resolveVoiceBinding(facts({ sidebarAgent: { id: 'agent-a' }, sidebarConversationId: null })),
    ).toEqual({ kind: 'resolving', surface: 'sidebar' });

    // And the global thread before it has been created.
    expect(resolveVoiceBinding(facts())).toEqual({ kind: 'resolving', surface: 'sidebar' });
  });

  it('should address a page-agent conversation the way the repository writes it', () => {
    // `conversationRepository.createConversation` writes type='page' with the
    // AGENT PAGE in contextId, and `transcript-persistence` reads contextId
    // back to decide where a spoken turn lands. If this drifts, transcripts go
    // to the wrong page or are dropped as 'unsupported_conversation_type'.
    const binding = resolveVoiceBinding(
      facts({ sidebarAgent: { id: 'agent-a' }, sidebarConversationId: 'conv-a' }),
    );

    expect(binding.kind).toBe('ready');
    if (binding.kind !== 'ready') return;
    expect(binding.target.type).toBe('page');
    expect(binding.target.contextId).toBe('agent-a');
  });
});

describe('isCallOnConversation — which surface renders the call chrome', () => {
  it('should match on the conversation, so a call follows its thread across surfaces', () => {
    const target = { conversationId: 'conv-a', type: 'page' as const, contextId: 'agent-a' };
    expect(isCallOnConversation(target, 'conv-a')).toBe(true);
    expect(isCallOnConversation(target, 'conv-b')).toBe(false);
  });

  it('should be false when there is no call, and when the surface has no conversation', () => {
    expect(isCallOnConversation(null, 'conv-a')).toBe(false);
    expect(
      isCallOnConversation({ conversationId: 'conv-a', type: 'global' }, null),
    ).toBe(false);
    // Two nulls are not a match: an unbound session and an unresolved surface
    // are not "the same conversation".
    expect(isCallOnConversation(null, null)).toBe(false);
  });
});
