'use client';

/**
 * DashboardWorkspaceView — the dashboard AS A SPLITTABLE PANE GRID.
 *
 * Replaces the old GlobalAssistantView overlay as the dashboard surface: what
 * you see is the user's DASHBOARD WORKSPACE (`agent_workspaces.kind =
 * 'dashboard'`, provisioned lazily server-side) rendered through the SAME
 * pane grid every other surface uses. Day one the tree holds a single chat
 * pane bound to the active global-assistant conversation — visually the
 * dashboard you had before, except every pane affordance now works: split it,
 * open a page beside it, drop in a terminal. The layout persists server-side
 * in the node tree, so it survives reloads, navigation, and devices.
 *
 * GlobalAssistantView remains ONLY as the fallback while the workspace is
 * being provisioned (first visit pays one POST) or if provisioning fails —
 * the dashboard must never blank out. Once the workspace id is in hand the
 * grid owns the surface; its state lives in the workspace store + the server
 * tree, not in component state, so navigation away and back costs a store
 * read rather than a remount of anything that matters.
 *
 * Provisioning rides SWR (the app's data convention) rather than a bespoke
 * effect: bounded retries, cache isolation per provider, and a one-shot key —
 * the request must not re-fire when the cookie identity changes later, so the
 * key is captured once at mount and the conversation it seeds is the one
 * active at first paint.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import AgentPanes from '@/components/agents/panes/AgentPanes';
import GlobalAssistantView from '@/components/layout/middle-content/page-views/dashboard/GlobalAssistantView';
import { useWorkspaceLayoutSync } from '@/stores/agent-workspace/useWorkspaceLayoutSync';
import { useGlobalChatConversation } from '@/contexts/GlobalChatContext';
import { useAuth } from '@/hooks/useAuth';
import { post } from '@/lib/auth/auth-fetch';
import { registerDashboardWorkspace } from '@/lib/agent-workspaces/dashboard-workspace-registry';

interface ProvisionResponse {
  workspaceId: string;
}

const PROVISION_KEY = 'dashboard-workspace';

export default function DashboardWorkspaceView() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  // The dashboard's conversation identity (cookie) at MOUNT time. Captured
  // once — the tree, not the cookie, is the layout's source of truth now, so
  // a later identity change must not re-provision.
  const currentConversationId = useGlobalChatConversation().currentConversationId;
  const [conversationId] = useState(currentConversationId);

  const provision = useCallback(async () => {
    return post<ProvisionResponse>('/api/agent-workspaces/dashboard', {
      conversationId,
    });
  }, [conversationId]);

  const { data, error } = useSWR(PROVISION_KEY, provision, {
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    // A failed provision retried a few times, then the fallback owns the
    // surface — no infinite hammering on a broken backend.
    shouldRetryOnError: true,
    errorRetryCount: 3,
  });

  // Registered against the SIGNED-IN USER for the rest of the session: the
  // sidebar's and voice's "new conversation" mint INTO this workspace, so
  // there is one creation path and the grid follows the app identity.
  useEffect(() => {
    if (userId !== null && data?.workspaceId) {
      registerDashboardWorkspace(userId, data.workspaceId);
    }
  }, [userId, data?.workspaceId]);

  // Readiness comes from the SWR DATA, not from the registry — the
  // registration is a side effect for modules outside this tree, and module
  // state never triggers a re-render.
  const workspaceId = userId !== null ? data?.workspaceId ?? null : null;

  if (error || !workspaceId) {
    // Provisioning (first visit) or failed: the assistant surface as it was
    // before the grid, so the dashboard is never blank.
    return <GlobalAssistantView />;
  }

  return (
    <DashboardGrid
      workspaceId={workspaceId}
      conversationId={conversationId}
    />
  );
}

function DashboardGrid({
  workspaceId,
  conversationId,
}: {
  workspaceId: string;
  conversationId: string | null;
}) {
  // AgentPanes mounts its own layout sync (GET + socket room) off this id.
  useWorkspaceLayoutSync(workspaceId);
  const { loadConversation, currentConversationId } = useGlobalChatConversation();

  // GRID → IDENTITY. A deliberate product decision, stated: the dashboard
  // tree IS the layout, so when the focused pane changes to a GLOBAL thread,
  // that thread becomes the app-wide identity — the sidebar and voice follow
  // what is on screen, not the other way round. The cost is accepted: a draft
  // typed against a different global conversation in the sidebar stops being
  // the active one the moment the dashboard mounts. Agent threads in the grid
  // deliberately do NOT touch the identity — the sidebar shows the assistant,
  // not whichever agent pane has focus.
  const currentConversationIdRef = useRef(currentConversationId);
  currentConversationIdRef.current = currentConversationId;
  const handleActiveConversationChanged = useCallback(
    (conversation: { conversationId: string; agentPageId: string | null } | null) => {
      if (
        conversation !== null &&
        conversation.agentPageId === null &&
        conversation.conversationId !== currentConversationIdRef.current
      ) {
        void loadConversation(conversation.conversationId);
      }
    },
    [loadConversation],
  );

  return (
    <AgentPanes
      sessionId={workspaceId}
      driveId={null}
      initialConversation={
        conversationId
          ? { conversationId, agentPageId: null, name: 'Global Assistant' }
          : null
      }
      chatContext="page"
      onActiveConversationChanged={handleActiveConversationChanged}
    />
  );
}
