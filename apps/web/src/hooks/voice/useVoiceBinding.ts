'use client';

import { useMemo } from 'react';

import { useDashboardContext } from '@/hooks/useDashboardContext';
import { useSidebarAgentStore } from '@/hooks/page-agents';
import { usePageAgentDashboardStore } from '@/stores/page-agents';
import { useGlobalChatConversation } from '@/contexts/GlobalChatContext';
import { resolveVoiceBinding, type VoiceBinding } from '@/lib/ai/realtime/voice-binding';

/**
 * The conversation the microphone would talk to, right now, on this route.
 *
 * This hook is ONLY the gather step — every store read, no decisions. What it
 * gathers goes straight into `resolveVoiceBinding`, which is pure and where the
 * "no second target picker" rule is actually enforced and tested.
 *
 * It is safe to mount anywhere inside `GlobalChatProvider`, which is where the
 * nav-bar trigger lives — and that matters more than it looks. The trigger is
 * on every route including ones where the sidebar is collapsed, so the binding
 * must be answerable WITHOUT the chat surface being mounted. Reading zustand
 * stores and the chat context (rather than asking the surface) is what makes
 * that true.
 */
export function useVoiceBinding(): VoiceBinding {
  const { isDashboardContext } = useDashboardContext();

  const sidebarAgent = useSidebarAgentStore((state) => state.selectedAgent);
  const sidebarConversationId = useSidebarAgentStore((state) => state.conversationId);
  const dashboardAgent = usePageAgentDashboardStore((state) => state.selectedAgent);
  const dashboardConversationId = usePageAgentDashboardStore((state) => state.conversationId);

  const { currentConversationId: globalConversationId } = useGlobalChatConversation();

  return useMemo(
    () =>
      resolveVoiceBinding({
        isDashboardContext,
        dashboardAgent: dashboardAgent ? { id: dashboardAgent.id } : null,
        dashboardConversationId,
        sidebarAgent: sidebarAgent ? { id: sidebarAgent.id } : null,
        sidebarConversationId,
        globalConversationId,
      }),
    [
      isDashboardContext,
      dashboardAgent,
      dashboardConversationId,
      sidebarAgent,
      sidebarConversationId,
      globalConversationId,
    ],
  );
}
