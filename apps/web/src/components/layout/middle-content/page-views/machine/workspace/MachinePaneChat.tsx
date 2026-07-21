"use client";

/**
 * MachinePaneChat — the "PageSpace Agent" pane's UI (Phase 11, #2166).
 *
 * The third selector surface: the header's agent picker chooses between the
 * machine-anchored assistant (null selection — the terminal row's own
 * conversation, machine-pane binding active) and any page agent. All chat
 * state lives in useMachinePaneChat; this component is tabs + presentation.
 *
 * Presentation is a compact, chrome-free, terminal-leaning skin: Conversation
 * + CompactMessageRenderer (via the shared SidebarMessagesContent) + ChatInput
 * (variant="sidebar"). No floating card, no share buttons — History mirrors
 * PageAgentHistoryTab minus its share controls (omitting onToggleShare hides
 * them). Rendered inside a split grid, so everything stays min-w-0/min-h-0
 * and the messages area contains its own layout.
 */
import React, { useCallback, useState } from 'react';
import {
  MessageSquare,
  History,
  Settings,
  Plus,
  Loader2,
  MoreHorizontal,
  SquareSplitHorizontal,
  SquareSplitVertical,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { ChatInput } from '@/components/ai/chat/input';
import { ProviderModelSelector } from '@/components/ai/chat/input/ProviderModelSelector';
import { AISelector } from '@/components/ai/shared';
import { UndoAiChangesDialog } from '@/components/ai/shared/chat';
import { ChatErrorBanner } from '@/components/ai/shared/chat/ChatErrorBanner';
import {
  Conversation,
  ConversationScrollButton,
} from '@/components/ai/ui/conversation';
import PageAgentHistoryTab from '@/components/ai/page-agents/PageAgentHistoryTab';
import { SidebarMessagesContent } from '@/components/layout/right-sidebar/ai-assistant/SidebarChatTab';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { hasVisionCapability } from '@/lib/ai/core/vision-models';
import PaneBar, { PaneSplitCloseActions, type PaneControlProps } from './PaneBar';
import { useMachinePaneChat } from './useMachinePaneChat';

export interface MachinePaneChatProps {
  /** The machine page this pane belongs to. */
  machineId: string;
  /** The terminal row id — the machine-anchored conversation (Phase 4). */
  terminalId: string;
  /** The picker's starting prompt, auto-sent once into a fresh conversation. */
  pendingPrompt?: string;
  /** Consumed-notification for pendingPrompt. */
  onPromptSent?: () => void;
  /** Drives the pane bar's focus tint — same grammar as every PTY pane. */
  isActive?: boolean;
  /** The pane-level split/close controls, merged into THIS component's bar —
   * a chat pane renders exactly one bar, so TerminalPane hands its controls
   * down instead of drawing a second bar (or floating chrome) above this one. */
  paneControls?: PaneControlProps;
}

type PaneTab = 'chat' | 'history' | 'settings';

export default function MachinePaneChat({
  machineId,
  terminalId,
  pendingPrompt,
  onPromptSent,
  isActive = false,
  paneControls,
}: MachinePaneChatProps) {
  const [activeTab, setActiveTab] = useState<PaneTab>('chat');
  const [input, setInput] = useState('');
  const [showError, setShowError] = useState(true);
  const [undoMessageId, setUndoMessageId] = useState<string | null>(null);

  const pane = useMachinePaneChat({
    machineId,
    terminalId,
    pendingPrompt,
    onPromptSent,
    historyEnabled: activeTab === 'history' || activeTab === 'chat',
  });

  const assistantName = pane.selectedAgent ? pane.selectedAgent.title : 'Agent';

  const handleSendClick = useCallback(async () => {
    const text = input;
    if (!text.trim()) return;
    // Clear immediately (typing during the handoff wait must not merge into
    // the old draft); restore only if the composer is still empty on refusal.
    setInput('');
    const dispatched = await pane.handleSend(text);
    if (!dispatched) {
      setInput((current) => (current === '' ? text : current));
    }
  }, [input, pane]);

  const handleSelectHistoryConversation = useCallback(
    (conversationId: string) => {
      void pane.openConversation(conversationId);
      setActiveTab('chat');
    },
    [pane],
  );

  const handleCreateConversation = useCallback(() => {
    void pane.createNewConversation().then((created) => {
      if (created) setActiveTab('chat');
    });
  }, [pane]);

  const handleUndoFromHere = useCallback((messageId: string) => {
    setUndoMessageId(messageId);
  }, []);

  const handleUndoSuccess = useCallback(async () => {
    setUndoMessageId(null);
    await pane.reloadConversation();
  }, [pane]);

  const remoteStreamingUser = !pane.displayIsStreaming
    ? pane.remoteStreams.find((s) => !s.isOwn)?.triggeredBy ?? null
    : null;

  return (
    // `@container` sizes the bar's fold to the PANE, not the viewport — a
    // 3-way split on a wide screen is exactly where the chat bar overflows.
    <div data-testid="machine-pane-chat" className="@container flex h-full min-w-0 flex-col bg-background">
      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as PaneTab)}
        className="flex h-full min-h-0 flex-col"
      >
        {/* The pane's ONE bar (pane-chrome redesign): agent picker as
            identity; tabs + new-conversation + the pane-level split/close
            controls merged as actions. Nothing floats over this header
            anymore — the old chip sat exactly on top of these tabs. */}
        <PaneBar
          isActive={isActive}
          identity={
            <AISelector
              selectedAgent={pane.selectedAgent}
              onSelectAgent={pane.selectAgent}
              disabled={pane.displayIsStreaming}
              className="min-w-0 flex-1 text-xs font-medium"
            />
          }
          actions={
            <>
              {/* Full-width run of controls — folds away under the container
                  threshold, replaced by the ⋯ menu below. Close never folds:
                  a control that destroys the pane must never be two clicks
                  deep or hidden behind a layout state. */}
              <span className="flex items-center gap-0.5 @max-[360px]:hidden">
                <TabsList className="h-6 shrink-0 p-0.5">
                  <TabsTrigger value="chat" aria-label="Chat" className="h-5 px-1.5">
                    <MessageSquare className="size-3.5" />
                  </TabsTrigger>
                  <TabsTrigger value="history" aria-label="History" className="h-5 px-1.5">
                    <History className="size-3.5" />
                  </TabsTrigger>
                  <TabsTrigger value="settings" aria-label="Settings" className="h-5 px-1.5">
                    <Settings className="size-3.5" />
                  </TabsTrigger>
                </TabsList>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleCreateConversation}
                  title="New conversation"
                  className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <Plus className="size-3.5" />
                </Button>
                {paneControls?.canSplit && (
                  <>
                    <div aria-hidden className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
                    <PaneSplitCloseActions {...paneControls} canClose={false} />
                  </>
                )}
              </span>
              <span className="hidden @max-[360px]:flex">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="More"
                      className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  {/* Menu clicks bubble through the Radix portal back into
                      TerminalPane's onClick={onSelect} — for a split action
                      that would immediately re-select the SOURCE pane,
                      undoing the new pane's activation. Same guard as
                      PaneSplitCloseActions' buttons. */}
                  <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenuItem onSelect={() => setActiveTab('chat')}>
                      <MessageSquare className="size-3.5" /> Chat
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setActiveTab('history')}>
                      <History className="size-3.5" /> History
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setActiveTab('settings')}>
                      <Settings className="size-3.5" /> Settings
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => handleCreateConversation()}>
                      <Plus className="size-3.5" /> New conversation
                    </DropdownMenuItem>
                    {paneControls?.canSplit && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => paneControls.onSplitRight()}>
                          <SquareSplitHorizontal className="size-3.5" /> Split right
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => paneControls.onSplitDown()}>
                          <SquareSplitVertical className="size-3.5" /> Split down
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
              {paneControls?.canClose && (
                <PaneSplitCloseActions {...paneControls} canSplit={false} />
              )}
            </>
          }
        />

        <TabsContent value="chat" className="mt-0 flex min-h-0 flex-1 flex-col overflow-hidden">
          {pane.hasLoadError && (
            <div className="flex items-center justify-between gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
              <span className="truncate">Failed to load messages</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => void pane.reloadConversation()}
              >
                Retry
              </Button>
            </div>
          )}

          <div className="min-h-0 min-w-0 flex-1 overflow-hidden" style={{ contain: 'layout' }}>
            {pane.isMessagesLoading && pane.messages.length === 0 && pane.remoteStreams.length === 0 ? (
              <div data-testid="machine-pane-chat-loading" className="flex h-full items-center justify-center">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <Conversation className="h-full">
                <SidebarMessagesContent
                  messages={pane.messages}
                  assistantName={assistantName}
                  contextLabel={null}
                  handleEdit={pane.handleEdit}
                  handleDelete={pane.handleDelete}
                  handleRetry={pane.handleRetry}
                  handleUndoFromHere={handleUndoFromHere}
                  lastAssistantMessageId={pane.lastAssistantMessageId}
                  lastUserMessageId={pane.lastUserMessageId}
                  displayIsStreaming={pane.displayIsStreaming}
                  remoteStreams={pane.remoteStreams}
                  onScrollNearTop={pane.handleScrollNearTop}
                  isLoadingOlder={pane.isLoadingOlder}
                  hasMoreOlder={pane.hasMoreOlder}
                />
                <ConversationScrollButton className="bottom-6 z-10" />
              </Conversation>
            )}
          </div>

          <div className="shrink-0 space-y-1.5 border-t border-border p-2">
            <ChatErrorBanner
              cause={pane.errorCause}
              show={showError}
              onClearError={() => {
                setShowError(false);
                pane.dismissError();
              }}
            />
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={() => void handleSendClick()}
              onStop={() => void pane.handleStop()}
              isStreaming={pane.displayIsStreaming}
              placeholder={
                pane.selectedAgent
                  ? `Message ${pane.selectedAgent.title}...`
                  : 'Message the machine agent...'
              }
              hideModelSelector
              variant="sidebar"
              hasVision={hasVisionCapability(pane.selectedAgent?.aiModel || '')}
              remoteStreamingUser={remoteStreamingUser}
            />
          </div>
        </TabsContent>

        <TabsContent value="history" className="mt-0 min-h-0 flex-1 overflow-hidden">
          {/* No onToggleShare — that is what removes the share controls. */}
          <PageAgentHistoryTab
            conversations={pane.conversations}
            currentConversationId={pane.currentConversationId}
            onSelectConversation={handleSelectHistoryConversation}
            onCreateNew={handleCreateConversation}
            onDeleteConversation={(conversationId) => void pane.deleteConversation(conversationId)}
            isLoading={pane.isLoadingConversations}
          />
        </TabsContent>

        <TabsContent value="settings" className="mt-0 min-h-0 flex-1 overflow-auto">
          <PaneSettings agent={pane.selectedAgent} />
        </TabsContent>
      </Tabs>

      <UndoAiChangesDialog
        open={!!undoMessageId}
        onOpenChange={(open) => !open && setUndoMessageId(null)}
        messageId={undoMessageId}
        onSuccess={handleUndoSuccess}
      />
    </div>
  );
}

/**
 * Slim settings, per mode (kept thin by design — the phase page's "Keep tabs
 * thin"): default mode edits the shared assistant settings store; agent mode
 * shows the agent's own configuration read-only — editing an agent belongs on
 * its page, not in a terminal pane.
 */
function PaneSettings({
  agent,
}: {
  agent: {
    title: string;
    driveName: string;
    aiProvider?: string;
    aiModel?: string;
    systemPrompt?: string;
  } | null;
}) {
  const currentProvider = useAssistantSettingsStore((state) => state.currentProvider);
  const currentModel = useAssistantSettingsStore((state) => state.currentModel);
  const setProviderSettings = useAssistantSettingsStore((state) => state.setProviderSettings);
  const webSearchEnabled = useAssistantSettingsStore((state) => state.webSearchEnabled);
  const toggleWebSearch = useAssistantSettingsStore((state) => state.toggleWebSearch);
  const writeMode = useAssistantSettingsStore((state) => state.writeMode);
  const toggleWriteMode = useAssistantSettingsStore((state) => state.toggleWriteMode);

  if (agent) {
    return (
      <div data-testid="machine-pane-agent-settings" className="space-y-3 p-3 text-xs">
        <div>
          <p className="font-medium">{agent.title}</p>
          <p className="text-muted-foreground">{agent.driveName}</p>
        </div>
        <dl className="space-y-1.5">
          <SettingsRow label="Provider" value={agent.aiProvider ?? 'Default'} />
          <SettingsRow label="Model" value={agent.aiModel ?? 'Default'} />
          <SettingsRow label="System prompt" value={agent.systemPrompt ? 'Custom' : 'None'} />
        </dl>
        <p className="text-muted-foreground">
          Configure {agent.title} on its own page.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="machine-pane-assistant-settings" className="space-y-3 p-3">
      <div className="space-y-1.5">
        <p className="text-xs font-medium">Model</p>
        <ProviderModelSelector
          provider={currentProvider}
          model={currentModel}
          onChange={setProviderSettings}
        />
      </div>
      <SettingsToggle label="Web search" checked={webSearchEnabled} onToggle={toggleWebSearch} />
      <SettingsToggle label="Write mode" checked={writeMode} onToggle={toggleWriteMode} />
    </div>
  );
}

function SettingsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  );
}

function SettingsToggle({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      role="switch"
      aria-checked={checked}
      onClick={onToggle}
      className={cn('h-7 w-full justify-between px-2 text-xs', checked && 'border-primary')}
    >
      <span>{label}</span>
      <span className="text-muted-foreground">{checked ? 'On' : 'Off'}</span>
    </Button>
  );
}
