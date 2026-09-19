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
 * effect: bounded retries, cache isolation per provider, and a USER-SCOPED
 * key — the module-level SWR cache outlives account switches, so the key
 * carries the signed-in user's id and the seed conversation is re-captured
 * when that user changes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import AgentPanes from '@/components/agents/panes/AgentPanes';
import GlobalAssistantView from '@/components/layout/middle-content/page-views/dashboard/GlobalAssistantView';
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
  const currentConversationId = useGlobalChatConversation().currentConversationId;
  // The dashboard's conversation identity (cookie) — captured per SIGNED-IN
  // USER, not per mount: the view survives account switches (CenterPanel
  // never unmounts it), and the next user must provision THEIR workspace
  // seeded with THEIR active conversation, not inherit a warm cache entry.
  const [conversationId, setConversationId] = useState(currentConversationId);
  useEffect(() => {
    setConversationId(currentConversationId);
    // Re-seed only when the signed-in user changes; a same-user cookie
    // change must not re-provision (the tree is the layout's truth now).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // The provision key is USER-SCOPED: the module-level SWR cache is shared
  // across the whole app and outlives this component, so a bare string key
  // could hand the next account the previous user's cached workspaceId.
  const provisionKey = userId ? ([PROVISION_KEY, userId] as const) : null;

  const provision = useCallback(async () => {
    return post<ProvisionResponse>('/api/agent-workspaces/dashboard', {
      conversationId,
    });
  }, [conversationId]);

  const { data, error } = useSWR(provisionKey, provision, {
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
  // Layout sync is NOT mounted here — `AgentPanes` does that itself for its
  // own workspace id; a second mount would double the snapshot fetch and the
  // socket room join for zero new information.
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
