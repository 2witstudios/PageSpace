'use client';

// The chat pane in the shell's chat slot: the agent chosen in its header
// (Imago unless another is), that agent's latest conversation (or the one the
// shell state names), the live turn and the composer. The shell keeps it
// mounted across every navigation; the agent, the draft and the open
// conversation live in shell state besides, so they outlast the pane too.
// Opening an object changes only the context a turn carries, never the agent
// or the conversation.

import { useEffect, useRef, type ReactNode } from 'react';
import { useRetainedChatSelection } from '@/retained-adapters/session-selection';
import { RetainedChat } from '@/retained-adapters/retained-chat';
import { ApiError } from '@/api/errors';
import { useUiState } from '@/ui/store/store';
import type { UiState } from '@/ui/store/state';
import { dispatch, transactions } from '@/ui/store/transactions';
import { usePageTrail } from '@/ui/tasks/use-tasks/use-tasks';
import { chatChipFor, chatContextFor, type Stage } from '../../frame/stage/stage';
import { tabLabelFor } from '../../frame/tabs/tab-label';
import { AgentPicker } from '../agent-picker/agent-picker';
import { SpendStrip } from '../spend-strip/spend-strip';
import { ChipsRow } from '../chips-row/chips-row';
import { ImagoHistory } from '../imago-history/imago-history';
import { FilesIntro } from '../files-intro/files-intro';
import { usePathname } from 'next/navigation';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import { ProviderModelSelector } from '@/retained/components/ai/chat/input/ProviderModelSelector';
import { useAssistantSettingsStore } from '@/retained/stores/useAssistantSettingsStore';
import { usePageTree } from '@/retained/hooks/usePageTree';
import { findNodeAndParent } from '@/retained/lib/tree/tree-utils';
import { useUIStore } from '@/retained/stores/useUIStore';
import { agentFor, agentMenu } from '../chat-agents/chat-agents';
import { shownConversationId } from '../chat-plugin';
import { useAgentConversations, useDriveAgents } from '../use-chat-data/use-chat-data';
import { useChatAgent } from '../use-chat-agent/use-chat-agent';
import { renderChatPane } from './chat-pane.render';

export type ChatPaneProps = {
  readonly stage: Stage;
  /** The open drive's name, once the drive list has it. */
  readonly driveName?: string;
  /** Where a cited page opens when the stage names no drive. */
  readonly homeDriveId: string | null;
  /** Show sidebar, when the pane is closed and Imago leads the middle. */
  readonly leading?: ReactNode;
  /** Collapse Imago while docked, or Close Imago while it fills the middle (SPEC v3.2). */
  readonly trailing?: ReactNode;
};

const selectConversation = (state: UiState) => state.resources.chatConversationId;
const selectNew = (state: UiState) => state.resources.chatNew;
const selectLost = (state: UiState) => state.resources.chatAgentLost;
const selectView = (state: UiState) => state.resources.chatView;

/** Imago's global model, as classic's composer keeps it; an agent page fixes its own. */
function ImagoModel() {
  const provider = useAssistantSettingsStore((state) => state.currentProvider);
  const model = useAssistantSettingsStore((state) => state.currentModel);
  const setProviderSettings = useAssistantSettingsStore((state) => state.setProviderSettings);
  return (
    <RetainedSurface fill={false}>
      <ProviderModelSelector provider={provider} model={model} onChange={setProviderSettings} />
    </RetainedSurface>
  );
}

/** How the agent routes say the viewer may no longer use an agent: it is gone (404) or not theirs to view (403). */
const lostAccess = (error: unknown): boolean => error instanceof ApiError && (error.status === 403 || error.status === 404);

const NOTICES = {
  lost: (name: string) => `You no longer have access to ${name}, so Imago is answering.`,
  setup: 'Imago is still being set up. Try again in a moment.',
  elsewhere: 'A reply is still coming in another chat.',
  load: 'This chat could not load. Try again in a moment.',
  reply: 'The reply failed. Try again.',
  stop: 'The reply could not be stopped.',
} as const;

/** The open page's own name: the last step of its trail, once it is that page's. */
const objectNameOf = (stage: Stage, trail: readonly { readonly id: string; readonly title: string }[] | undefined) => {
  const last = trail?.at(-1);
  return stage.object?.kind === 'page' && last?.id === stage.object.pageId ? last.title : undefined;
};

export function ChatPane({ stage, driveName, homeDriveId, leading = null, trailing = null }: ChatPaneProps) {
  const retainedSelection = useRetainedChatSelection(state => state.selection);
  const { agents, chosenAgent, agentId, agentName, error: agentsError } = useChatAgent();
  const { agents: driveAgents } = useDriveAgents(stage.driveId);
  const lost = useUiState(selectLost);
  const chatHost = useRef<HTMLDivElement>(null);
  const previousSection = useRef(stage.section);
  useEffect(() => {
    const returned = stage.section === 'chat' && previousSection.current !== 'chat';
    previousSection.current = stage.section;
    if (returned && document.querySelector('[aria-modal="true"], dialog[open]') === null) {
      chatHost.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    }
  }, [stage.section]);
  const { conversations, error: conversationsError } = useAgentConversations(agentId);
  // The server is the judge of access: a refused agent hands the chat back to Imago.
  useEffect(() => {
    if (chosenAgent !== null && lostAccess(conversationsError)) dispatch(transactions.loseAgent, chosenAgent.id);
  }, [chosenAgent, conversationsError]);
  const chosen = useUiState(selectConversation);
  const chatNew = useUiState(selectNew);
  const conversationId = shownConversationId({ chatConversationId: chosen, chatNew }, conversations?.[0]?.id ?? null);

  const { trail } = usePageTrail(stage.object?.kind === 'page' ? stage.object.pageId : null);
  const pathname = usePathname() ?? '/';
  const view = useUiState(selectView);
  const { tree } = usePageTree(stage.driveId ?? undefined);
  const folderTitle = (pageId: string) => findNodeAndParent(tree, pageId)?.node.title;
  const screen = tabLabelFor(pathname);
  const resolving = !chatNew && chosen === null && conversations === undefined && conversationsError === undefined;
  const context = chatContextFor(stage, { drive: driveName, object: objectNameOf(stage, trail) });
  const headerAgent = retainedSelection ? {
    id: retainedSelection.agentId ?? 'retained-global-assistant',
    title: retainedSelection.agentTitle ?? (retainedSelection.agentId === null ? 'Imago' : 'Opening agent…'),
  } : chosenAgent;
  // The Files ground: no page open, so the column opens with the drive's page count (IMC-2.12).
  const filesGround = stage.section === 'files' && stage.object === null && stage.driveId !== null;
  const thread = view === 'history' ? <ImagoHistory agentId={agentId} activeId={conversationId} /> : <div ref={chatHost} className={context.density === 'roomy' ? 'mx-auto h-full min-h-0 w-full max-w-imago-ground' : 'h-full min-h-0'}><RetainedChat home={stage.section === 'chat'} agentId={agentId} name={agentName} conversationId={conversationId} resolving={resolving} placeholder={context.placeholder} aboveComposer={<><ChipsRow conversationId={conversationId} agentId={agentId} driveId={stage.driveId ?? undefined} /><SpendStrip /></>} /></div>;
  return renderChatPane({
    density: context.density,
    agentName: headerAgent?.title ?? agentName,
    leading,
    trailing,
    picker: (
      <AgentPicker
        agentName={headerAgent?.title ?? agentName}
        imago={headerAgent === null || retainedSelection?.agentId === null}
        agents={agentMenu({ builtins: agents, driveAgents, driveName, selected: retainedSelection?.agentId === null ? null : headerAgent, folderTitle })}
        selectAgent={(value) => {
          useRetainedChatSelection.getState().select(null);
          const next = agentFor({ builtins: agents, driveAgents }, value);
          if (next !== undefined) dispatch(transactions.selectAgent, next);
        }}
        model={<ImagoModel />}
        allAgentsHref={stage.driveId === null ? null : `/${encodeURIComponent(stage.driveId)}/agents`}
        onNewAgent={stage.driveId === null ? null : () => useUIStore.getState().openQuickCreate(null)}
      />
    ),
    chip: chatChipFor(stage, { object: objectNameOf(stage, trail), screen: screen.kind === 'screen' ? screen.title : undefined }),
    onHistory: () => dispatch(transactions.toggleChatHistory, undefined),
    historyOpen: view === 'history',
    onNewChat: () => {
      useRetainedChatSelection.getState().select(null);
      dispatch(transactions.startNewChat, undefined);
    },
    contextLabel: context.contextLabel,
    messages: [],
    streamingMessageId: null,
    notice: agentsError !== undefined || conversationsError !== undefined ? NOTICES.load : lost ? NOTICES.lost(lost) : null,
    citationDriveId: stage.driveId ?? homeDriveId,
    content: filesGround && stage.driveId !== null ? (
      <div className="flex h-full min-h-0 flex-col">
        <FilesIntro driveId={stage.driveId} driveName={driveName} />
        <div className="min-h-0 flex-1">{thread}</div>
      </div>
    ) : thread,
    composer: null,
  });
}
