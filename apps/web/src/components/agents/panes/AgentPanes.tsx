'use client';

/**
 * AgentPanes — the container that turns the pure pane pieces into a working
 * grid for ONE session.
 *
 * Composition per pane, via `resolvePaneSurface`:
 *
 * ```
 * SessionPanes (layout only, surfaces injected)
 *  └─ pane: PaneBar (identity + split/close) over
 *      picker   → PanePicker      (unbound — choose an agent or a shell)
 *      chat     → PaneChat        (a conversation IN this session)
 *      terminal → Shell           (a PTY on this session's sandbox)
 *      loading  → spinner         (bound, row not minted yet — never a
 *                                  speculative terminal)
 * ```
 *
 * The container owns ALL the IO a pick triggers — minting a conversation into
 * THIS session, opening a shell on THIS session — and writes the resulting
 * `PaneScope` back through `assignPane`. Sandbox identity is never threaded
 * anywhere: every conversation and shell here resolves the session's one
 * sandbox by construction (the Sprite key folds the session id).
 *
 * Closing the LAST pane ends the session: the store intercepts it and answers
 * `'session-ended'`, and this container performs the teardown IO (DELETE the
 * session) and tells its host, which owns what the empty state looks like.
 */

import { useCallback } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { post, del } from '@/lib/auth/auth-fetch';
import { useAgentWorkspaceStore } from '@/stores/agent-workspace/useAgentWorkspaceStore';
import type { PaneState } from '@/stores/agent-workspace/pane-reducer';
import { usePageAgents } from '@/hooks/page-agents/usePageAgents';
import SessionPanes from './SessionPanes';
import PaneBar, { PaneSessionIdentity, PaneSplitCloseActions } from './PaneBar';
import PanePicker, { type PickableAgent } from './PanePicker';
import { resolvePaneSurface } from './pane-surface';
import PaneChat from './PaneChat';
import Shell from '../shell/Shell';

export interface AgentPanesProps {
  /** The session this grid belongs to (`agent_sessions.id`). */
  sessionId: string;
  /** The session's drive — where the picker's agent list comes from. Null for a global-assistant session. */
  driveId: string | null;
  /**
   * The session's FIRST conversation, used once to seed the opening pane (a
   * session is born with one — the grid never starts on a picker).
   */
  initialConversation: { conversationId: string; agentPageId: string | null; name: string };
  /** Fired after the last pane closed and the session was ended — the host owns what renders next. */
  onSessionEnded?: () => void;
  /**
   * Which message renderer chat panes use — the agent PAGE hosts the grid with
   * the full renderer, the console with the compact one. Layout is identical.
   */
  chatContext?: 'page' | 'console';
}

export default function AgentPanes({
  sessionId,
  driveId,
  initialConversation,
  onSessionEnded,
  chatContext = 'console',
}: AgentPanesProps) {
  const workspaces = useAgentWorkspaceStore((state) => state.workspaces);
  const ensureWorkspace = useAgentWorkspaceStore((state) => state.ensureWorkspace);
  const splitRight = useAgentWorkspaceStore((state) => state.splitRight);
  const splitDown = useAgentWorkspaceStore((state) => state.splitDown);
  const closePane = useAgentWorkspaceStore((state) => state.closePane);
  const selectPane = useAgentWorkspaceStore((state) => state.selectPane);
  const assignPane = useAgentWorkspaceStore((state) => state.assignPane);
  const dismissPicker = useAgentWorkspaceStore((state) => state.dismissPicker);

  // The picker's agent list — the session's drive only. A global-assistant
  // session offers no drive agents (there is no drive to list).
  const { allAgents, isLoading: agentsLoading } = usePageAgents(driveId ?? undefined, {
    enabled: driveId !== null,
  });
  const pickableAgents: PickableAgent[] = (allAgents ?? [])
    .filter((agent) => agent.driveId === driveId)
    .map((agent) => ({ id: agent.id, title: agent.title ?? 'Agent' }));

  const workspace = workspaces[sessionId];
  if (!workspace) {
    ensureWorkspace(sessionId, {
      kind: 'chat',
      name: initialConversation.name,
      targetId: initialConversation.conversationId,
      agentPageId: initialConversation.agentPageId,
    });
  }

  const handleClosePane = useCallback(
    async (paneId: string) => {
      const verdict = closePane(sessionId, paneId);
      if (verdict !== 'session-ended') return;
      // Emptying the session ends it — one act, per the lifecycle invariant.
      try {
        await del(`/api/agent-sessions/${encodeURIComponent(sessionId)}`);
      } catch (error) {
        // The grid is already gone locally; the sandbox teardown failing is
        // worth saying because it keeps billing until the reclaim path runs.
        console.error('Failed to end session:', error);
        toast.error('Could not stop the sandbox', {
          description: error instanceof Error ? error.message : 'It will be cleaned up automatically.',
        });
      }
      onSessionEnded?.();
    },
    [closePane, sessionId, onSessionEnded],
  );

  const handlePickAgent = useCallback(
    async (paneId: string, agentPageId: string | null) => {
      const conversationId = createId();
      // Bind first, render after: the pane goes to `loading` (kind set, target
      // null) while the mint is in flight — never a speculative surface.
      assignPane(sessionId, paneId, { kind: 'chat', name: 'New conversation', targetId: null, agentPageId });
      try {
        if (agentPageId === null) {
          // The ASSISTANT: no agent page, so the session-centric creator is
          // the path (page-agents has no page to hang this on).
          await post(`/api/agent-sessions/${encodeURIComponent(sessionId)}/conversations`, {
            conversationId,
          });
        } else {
          await post(`/api/ai/page-agents/${encodeURIComponent(agentPageId)}/conversations`, {
            conversationId,
            sessionId,
          });
        }
        assignPane(sessionId, paneId, { kind: 'chat', name: 'New conversation', targetId: conversationId, agentPageId });
      } catch (error) {
        console.error('Failed to start a conversation in this pane:', error);
        toast.error('Could not start a conversation', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        // Back to the picker — a pane stuck on `loading` forever is a dead pane.
        assignPane(sessionId, paneId, { kind: 'chat', name: '', targetId: null, agentPageId: null });
        dismissPicker(sessionId, paneId);
      }
    },
    [assignPane, dismissPicker, sessionId],
  );

  const handlePickShell = useCallback(
    async (paneId: string) => {
      assignPane(sessionId, paneId, { kind: 'terminal', name: 'shell', targetId: null, agentPageId: null });
      try {
        const { shell } = await post<{ shell: { shellId: string; name: string } }>(
          `/api/agent-sessions/${encodeURIComponent(sessionId)}/shells`,
          {},
        );
        assignPane(sessionId, paneId, { kind: 'terminal', name: shell.name, targetId: shell.shellId, agentPageId: null });
      } catch (error) {
        console.error('Failed to open a shell in this pane:', error);
        toast.error('Could not open a shell', {
          description: error instanceof Error ? error.message : 'Please try again.',
        });
        assignPane(sessionId, paneId, { kind: 'chat', name: '', targetId: null, agentPageId: null });
        dismissPicker(sessionId, paneId);
      }
    },
    [assignPane, dismissPicker, sessionId],
  );

  if (!workspace) {
    // ensureWorkspace above lands on the next render tick.
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderPane = ({ pane, isActive, canSplit }: { pane: PaneState; isActive: boolean; canSplit: boolean }) => {
    // An unbound pane (scope null) OR a bound-but-unresolved CHAT pane with no
    // target and no agent renders the picker (the error-recovery reset above
    // produces the latter shape).
    const surface = resolvePaneSurface(pane.scope);
    const showPicker =
      surface.surface === 'picker' ||
      (surface.surface === 'loading' && pane.scope?.kind === 'chat' && pane.scope.agentPageId === null && pane.scope.name === '');

    return (
      <div
        className="group/pane flex h-full min-h-0 flex-col"
        onClick={() => selectPane(sessionId, pane.id)}
      >
        <PaneBar
          isActive={isActive}
          identity={
            pane.scope ? (
              <PaneSessionIdentity name={pane.scope.name || 'pane'} />
            ) : (
              <span className="text-muted-foreground">New pane</span>
            )
          }
          actions={
            <PaneSplitCloseActions
              canSplit={canSplit}
              canClose
              onSplitRight={() => splitRight(sessionId, pane.id)}
              onSplitDown={() => splitDown(sessionId, pane.id)}
              onClose={() => void handleClosePane(pane.id)}
            />
          }
        />
        <div className="min-h-0 flex-1">
          {showPicker ? (
            <PanePicker
              agents={pickableAgents}
              isLoading={driveId !== null && agentsLoading}
              // The assistant identity path is live (AssistantSessionChat), so
              // every session can host an assistant thread beside its agents.
              canPickAssistant
              autoFocus={workspace.pendingPickerPaneId === pane.id}
              onPickAgent={(agentPageId) => void handlePickAgent(pane.id, agentPageId)}
              onPickShell={() => void handlePickShell(pane.id)}
            />
          ) : surface.surface === 'loading' ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : surface.surface === 'chat' ? (
            <PaneChat conversationId={surface.conversationId} agentPageId={surface.agentPageId} context={chatContext} />
          ) : (
            <Shell shellId={surface.shellId} name={pane.scope?.name} />
          )}
        </div>
      </div>
    );
  };

  return <SessionPanes workspace={workspace} onSelectPane={(paneId) => selectPane(sessionId, paneId)} renderPane={renderPane} />;
}
