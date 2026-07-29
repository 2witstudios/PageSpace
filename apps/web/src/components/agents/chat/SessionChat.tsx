'use client';

/**
 * SessionChat — the ONE chat surface, rendered identically wherever an agent
 * conversation appears.
 *
 * Presentation only; all state comes from `useAgentSessionChat`. `context`
 * selects the message renderer, and nothing else changes: `'page'` gets the
 * full `MessageRenderer` (via `ChatMessagesArea`, which also owns virtualization
 * and its own undo dialog), `'console'` gets the `CompactMessageRenderer` (via
 * the sidebar's `SidebarMessagesContent`, chrome-free and narrow-width safe).
 *
 * Self-contained by design (`@container`, `h-full min-w-0 min-h-0`, identity
 * via props, no layout props) so a future pane grid can embed this unchanged —
 * see the design doc's "v1 = tabs, not split panes" note.
 */
import React, { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ChatInput } from '@/components/ai/chat/input';
import { UndoAiChangesDialog } from '@/components/ai/shared/chat';
import { ChatErrorBanner } from '@/components/ai/shared/chat/ChatErrorBanner';
import { ChatMessagesArea } from '@/components/ai/shared/chat/ChatMessagesArea';
import { Conversation, ConversationScrollButton } from '@/components/ai/ui/conversation';
import { SidebarMessagesContent } from '@/components/layout/right-sidebar/ai-assistant/SidebarChatTab';
import { hasVisionCapability } from '@/lib/ai/core/vision-models';
import type { AgentInfo } from '@/types/agent';
import { useAgentSessionChat } from './useAgentSessionChat';

export interface SessionChatProps {
  /** The fixed agent this conversation belongs to. */
  agent: AgentInfo;
  /** ≡ the sessionId. */
  conversationId: string;
  /** Which renderer/chrome to use — the only thing that differs between surfaces. */
  context: 'page' | 'console';
  /** Read-only viewers get history but no send/edit/delete/retry affordances. */
  isReadOnly?: boolean;
}

export default function SessionChat({
  agent,
  conversationId,
  context,
  isReadOnly = false,
}: SessionChatProps) {
  const [input, setInput] = useState('');
  const [showError, setShowError] = useState(true);
  const [undoMessageId, setUndoMessageId] = useState<string | null>(null);

  const chat = useAgentSessionChat({ agent, conversationId });

  const handleSendClick = useCallback(async () => {
    const text = input;
    if (!text.trim()) return;
    // Clear immediately — typing during the handoff wait must not merge into
    // the old draft; restore only if the composer is still empty on refusal.
    setInput('');
    const dispatched = await chat.handleSend(text);
    if (!dispatched) {
      setInput((current) => (current === '' ? text : current));
    }
  }, [input, chat]);

  const handleUndoSuccess = useCallback(async () => {
    setUndoMessageId(null);
    await chat.reloadConversation();
  }, [chat]);

  const remoteStreamingUser = !chat.displayIsStreaming
    ? chat.remoteStreams.find((s) => !s.isOwn)?.triggeredBy ?? null
    : null;

  const showLoading =
    chat.isMessagesLoading && chat.messages.length === 0 && chat.remoteStreams.length === 0;

  return (
    <div
      data-testid="session-chat"
      className="@container flex h-full min-w-0 min-h-0 flex-col bg-background"
    >
      {chat.hasLoadError && (
        <div className="flex items-center justify-between gap-2 border-b border-destructive/20 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <span className="truncate">Failed to load messages</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void chat.reloadConversation()}
          >
            Retry
          </Button>
        </div>
      )}

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {showLoading ? (
          <div data-testid="session-chat-loading" className="flex h-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : context === 'page' ? (
          <ChatMessagesArea
            messages={chat.messages}
            isLoading={chat.isMessagesLoading}
            isStreaming={chat.displayIsStreaming}
            onEdit={!isReadOnly ? chat.handleEdit : undefined}
            onDelete={!isReadOnly ? chat.handleDelete : undefined}
            onRetry={!isReadOnly ? chat.handleRetry : undefined}
            lastAssistantMessageId={chat.lastAssistantMessageId}
            lastUserMessageId={chat.lastUserMessageId}
            isReadOnly={isReadOnly}
            onUndoSuccess={() => void chat.reloadConversation()}
            onScrollNearTop={chat.handleScrollNearTop}
            isLoadingOlder={chat.isLoadingOlder}
            remoteStreams={chat.remoteStreams}
          />
        ) : (
          <Conversation className="h-full">
            <SidebarMessagesContent
              messages={chat.messages}
              assistantName={agent.title}
              contextLabel={null}
              handleEdit={chat.handleEdit}
              handleDelete={chat.handleDelete}
              handleRetry={chat.handleRetry}
              handleUndoFromHere={(messageId) => setUndoMessageId(messageId)}
              lastAssistantMessageId={chat.lastAssistantMessageId}
              lastUserMessageId={chat.lastUserMessageId}
              displayIsStreaming={chat.displayIsStreaming}
              remoteStreams={chat.remoteStreams}
              onScrollNearTop={chat.handleScrollNearTop}
              isLoadingOlder={chat.isLoadingOlder}
              hasMoreOlder={chat.hasMoreOlder}
            />
            <ConversationScrollButton className="bottom-6 z-10" />
          </Conversation>
        )}
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-border p-2">
        <ChatErrorBanner
          cause={chat.errorCause}
          show={showError}
          onClearError={() => {
            setShowError(false);
            chat.dismissError();
          }}
        />
        <ChatInput
          value={input}
          onChange={setInput}
          onSend={() => void handleSendClick()}
          onStop={() => void chat.handleStop()}
          isStreaming={chat.displayIsStreaming}
          disabled={isReadOnly}
          placeholder={isReadOnly ? 'View only' : `Message ${agent.title}...`}
          hideModelSelector
          variant={context === 'console' ? 'sidebar' : 'main'}
          hasVision={hasVisionCapability(agent.aiModel || '')}
          remoteStreamingUser={remoteStreamingUser}
        />
      </div>

      {/* Only the console path renders this itself — ChatMessagesArea (page
          context) already owns its own UndoAiChangesDialog internally. */}
      {context === 'console' && (
        <UndoAiChangesDialog
          open={!!undoMessageId}
          onOpenChange={(open) => !open && setUndoMessageId(null)}
          messageId={undoMessageId}
          onSuccess={() => void handleUndoSuccess()}
        />
      )}
    </div>
  );
}
