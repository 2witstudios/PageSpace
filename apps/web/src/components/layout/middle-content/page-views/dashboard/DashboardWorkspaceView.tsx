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
 * being provisioned (first visit pays one GET) or if provisioning fails —
 * the dashboard must never blank out. Once the workspace id is in hand the
 * grid owns the surface; its state lives in the workspace store + the server
 * tree, not in component state, so navigation away and back costs a store
 * read rather than a remount of anything that matters.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import AgentPanes from '@/components/agents/panes/AgentPanes';
import GlobalAssistantView from '@/components/layout/middle-content/page-views/dashboard/GlobalAssistantView';
import { useWorkspaceLayoutSync } from '@/stores/agent-workspace/useWorkspaceLayoutSync';
import { useGlobalChatConversation } from '@/contexts/GlobalChatContext';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import {
  registerDashboardWorkspace,
} from '@/lib/agent-workspaces/dashboard-workspace-registry';

type ProvisionState =
  | { status: 'loading' }
  | { status: 'ready'; workspaceId: string }
  | { status: 'error' };

export default function DashboardWorkspaceView() {
  // The dashboard's conversation identity (cookie). Read through a ref: the
  // provision request fires ONCE — the conversation it seeds is the one active
  // at first paint, and a later identity change must not re-provision (the
  // tree, not the cookie, is the layout's source of truth now).
  const { currentConversationId } = useGlobalChatConversation();
  const conversationIdRef = useRef(currentConversationId);
  conversationIdRef.current = currentConversationId;

  const [state, setState] = useState<ProvisionState>({ status: 'loading' });

  // Registered for the rest of the tab session (never unregistered): the
  // sidebar's and voice's "new conversation" mint INTO this workspace, so
  // there is one creation path and the grid follows the app identity.
  useEffect(() => {
    if (state.status === 'ready') {
      registerDashboardWorkspace(state.workspaceId);
    }
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    const conversationId = conversationIdRef.current;
    const qs = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '';
    fetchWithAuthJson<{ workspaceId: string }>(`/api/agent-workspaces/dashboard${qs}`)
      .then((body) => {
        if (!cancelled && body?.workspaceId) {
          setState({ status: 'ready', workspaceId: body.workspaceId });
        } else if (!cancelled) {
          setState({ status: 'error' });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status !== 'ready') {
    // Provisioning (first visit) or failed: the assistant surface as it was
    // before the grid, so the dashboard is never blank.
    return <GlobalAssistantView />;
  }

  return (
    <DashboardGrid
      workspaceId={state.workspaceId}
      conversationId={conversationIdRef.current}
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

  // GRID → IDENTITY: when the focused pane changes, a GLOBAL thread becomes
  // the app-wide assistant identity (cookie + sidebar + voice follow the
  // grid). Agent threads in the grid deliberately do NOT touch the identity —
  // the sidebar shows the assistant, not whichever agent pane has focus.
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

async function fetchWithAuthJson<T>(url: string): Promise<T | null> {
  const response = await fetchWithAuth(url);
  if (!response.ok) return null;
  return (await response.json()) as T;
}
