/**
 * WHICH conversation the microphone talks to, decided from what is on screen.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: there is no voice target picker.
 * Voice is not a feature with its own destination — it is a second transport
 * onto the conversation the user is already looking at. So the target is
 * DERIVED from the surface in view, never chosen, and every route has exactly
 * one answer:
 *
 *   - On the dashboard, `GlobalAssistantView` is the conversation on screen and
 *     the right sidebar has NO chat tab at all (`showChatTab = !isDashboardContext`).
 *     Binding to the sidebar there would bind to a surface that does not exist.
 *   - On every other route the sidebar's chat tab is the assistant in view, and
 *     it keeps its own agent selection, independent of the dashboard's.
 *
 * Each surface is a PAIR — an agent selection and the conversation id that
 * selection resolved to — and the pairs must never be crossed. Taking the
 * dashboard's agent with the sidebar's conversation id would open a call to one
 * agent that writes its transcript into another agent's thread, which is a data
 * error the user cannot see until it has already happened.
 *
 * WHY 'resolving' IS A FIRST-CLASS ANSWER AND NOT `null`. Selecting an agent
 * clears the conversation id and re-resolves it asynchronously (see
 * `usePageAgentSidebarState`), so "no conversation id yet" is a normal, brief,
 * self-healing state — not a failure and not a reason to say voice is
 * unavailable. The trigger waits; it does not refuse and it does not invent a
 * conversation.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state.
 */

import type { VoiceTarget } from './voice-target';

/** Where the call's chrome renders, which is the same place the conversation renders. */
export type VoiceSurface = 'dashboard' | 'sidebar';

/** The minimum an agent selection has to expose to be bindable. */
export type VoiceBindingAgent = {
  readonly id: string;
};

export type VoiceBindingFacts = {
  /**
   * `useDashboardContext().isDashboardContext` — true ONLY on `/dashboard` and
   * a drive root, the two routes where `GlobalAssistantView` holds the centre.
   */
  readonly isDashboardContext: boolean;
  /** `usePageAgentDashboardStore` — the pair the dashboard's centre panel shows. */
  readonly dashboardAgent: VoiceBindingAgent | null;
  readonly dashboardConversationId: string | null;
  /** `useSidebarAgentStore` — the pair the sidebar's chat tab shows. */
  readonly sidebarAgent: VoiceBindingAgent | null;
  readonly sidebarConversationId: string | null;
  /**
   * `useGlobalChatConversation` — the global assistant thread, shared by BOTH
   * surfaces when neither has an agent selected. One conversation, because the
   * global assistant is one assistant however you reach it.
   */
  readonly globalConversationId: string | null;
};

export type VoiceBinding =
  | {
      readonly kind: 'ready';
      readonly surface: VoiceSurface;
      readonly target: VoiceTarget;
    }
  | {
      /** The surface is known; its conversation id is still being resolved. */
      readonly kind: 'resolving';
      readonly surface: VoiceSurface;
    };

/**
 * A page-agent conversation, addressed the way the rest of the app addresses
 * one: `type: 'page'` with the AGENT PAGE in `contextId`. That is not an
 * approximation — it is literally the row `conversationRepository.createConversation`
 * writes (`type: 'page'`, `contextId: pageId`), and the same field the
 * transcript writer reads back to decide where a spoken turn lands.
 *
 * `agentPageId` repeats it deliberately: `sameVoiceTarget` compares every
 * addressing field, and carrying the agent explicitly is what lets a switch
 * between two agents be recognised as a rebind even mid-resolution.
 */
const agentTarget = (agentId: string, conversationId: string): VoiceTarget => ({
  conversationId,
  type: 'page',
  contextId: agentId,
  agentPageId: agentId,
});

const globalTarget = (conversationId: string): VoiceTarget => ({
  conversationId,
  type: 'global',
});

export const resolveVoiceBinding = (facts: VoiceBindingFacts): VoiceBinding => {
  const surface: VoiceSurface = facts.isDashboardContext ? 'dashboard' : 'sidebar';

  // The pair, taken together or not at all.
  const agent = facts.isDashboardContext ? facts.dashboardAgent : facts.sidebarAgent;
  const agentConversationId = facts.isDashboardContext
    ? facts.dashboardConversationId
    : facts.sidebarConversationId;

  if (agent) {
    return agentConversationId
      ? { kind: 'ready', surface, target: agentTarget(agent.id, agentConversationId) }
      : { kind: 'resolving', surface };
  }

  return facts.globalConversationId
    ? { kind: 'ready', surface, target: globalTarget(facts.globalConversationId) }
    : { kind: 'resolving', surface };
};

/**
 * Whether a live session is speaking into the conversation this surface is
 * showing — the one test that decides whether a chat surface renders the call
 * chrome.
 *
 * Deliberately keyed on the CONVERSATION and not on the surface: a call started
 * from the sidebar and then walked to the dashboard is still that conversation's
 * call, and the surface that happens to be showing that conversation is where
 * its chrome belongs. Anything keyed on "which surface started it" would make
 * the call a property of a panel, which is the failure mode the whole design is
 * built to avoid.
 */
export const isCallOnConversation = (
  target: VoiceTarget | null,
  conversationId: string | null,
): boolean =>
  target !== null && conversationId !== null && target.conversationId === conversationId;
