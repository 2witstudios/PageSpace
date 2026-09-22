'use client';

import React, { forwardRef, useRef, useImperativeHandle, useEffect, useCallback } from 'react';
import { Lock } from 'lucide-react';
import type { UIMessage } from 'ai';
import { cn } from '@/lib/utils';
import { ChatTextarea, type ChatTextareaRef } from './ChatTextarea';
import { InputActions } from './InputActions';
import { AttachButton } from './AttachButton';
import { AttachmentPreviewStrip } from './AttachmentPreviewStrip';
import { QueueTray } from './QueueTray';
import { InputFooter } from '@/components/ui/floating-input';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { useToolApprovalSettings } from '@/lib/ai/shared/hooks/useToolApprovalSettings';
import { isImageGenerationAllowed } from '@/lib/ai/core/image-gen-access';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard';
import type { ImageAttachment } from '@/lib/ai/shared/hooks/useImageAttachments';

/**
 * Two ESC presses inside this window are a STRONGER interrupt (issue #2676):
 * the first stops the stream (the abort's terminal event then drains the
 * queue), the second clears the queue AND cancels that pending drain — the
 * double-press convention command-line harnesses use. A timestamp comparison,
 * not a timer: nothing is scheduled, the window simply expires.
 */
const DOUBLE_ESC_INTERRUPT_MS = 1000;

export interface ChatInputProps {
  /** Current input value */
  value: string;
  /** Input change handler */
  onChange: (value: string) => void;
  /** Send message handler */
  onSend: () => void;
  /** Stop streaming handler */
  onStop: () => void;
  /** Detached /btw handler. Unlike ordinary sends, this remains available during a local stream. */
  onSideQuestion?: () => void;
  /** Whether AI is currently streaming */
  isStreaming: boolean;
  /** A Stop has been requested and has not resolved yet — see InputActions. */
  isStopping?: boolean;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Drive ID for mention suggestions */
  driveId?: string;
  /**
   * Drive scope for the `/` command picker — defaults to `driveId`. Set it
   * when the two differ (an agent conversation scopes commands to the AGENT's
   * drive while mentions stay on the route's), and see `ChatTextareaProps`
   * for the invariant it must satisfy.
   */
  commandDriveId?: string;
  /** Enable cross-drive mention search */
  crossDrive?: boolean;
  /** Hide the model/provider selector in footer (for compact layouts) */
  hideModelSelector?: boolean;
  /** Style variant: 'main' for InputCard context, 'sidebar' for sidebar contrast */
  variant?: 'main' | 'sidebar';
  /**
   * Show the global assistant's tool-approval controls (Ask before actions +
   * always-allowed list) in the Tools menu. Only the global assistant's
   * composer sets this — a page agent's mode lives on its settings tab.
   */
  showToolApprovalSettings?: boolean;
  /** Number of running MCP servers */
  mcpRunningServers?: number;
  /** Names of running MCP servers */
  mcpServerNames?: string[];
  /** Number of enabled MCP servers */
  mcpEnabledCount?: number;
  /** Whether all MCP servers are enabled */
  mcpAllEnabled?: boolean;
  /** Toggle all MCP servers */
  onMcpToggleAll?: (enabled: boolean) => void;
  /** Check if specific server is enabled */
  isMcpServerEnabled?: (serverName: string) => boolean;
  /** Toggle specific server */
  onMcpServerToggle?: (serverName: string, enabled: boolean) => void;
  /** Whether MCP section should be shown (desktop only) */
  showMcp?: boolean;
  /** Popup placement for mention suggestions: 'top' (default) for docked input, 'bottom' for centered input */
  popupPlacement?: 'top' | 'bottom';
  /** Override provider from props (for page-level settings) */
  selectedProvider?: string | null;
  /** Override model from props (for page-level settings) */
  selectedModel?: string | null;
  /** Handler when provider/model changes (for page-level settings) */
  onProviderModelChange?: (provider: string, model: string) => void;
  /** Image attachments for vision support */
  attachments?: ImageAttachment[];
  /** Handler to add image files */
  onAddFiles?: (files: File[]) => void;
  /** Handler to remove an image attachment */
  onRemoveFile?: (id: string) => void;
  /** Whether the current model supports vision */
  hasVision?: boolean;
  /** When set, another user (or another tab/device for the same user) is currently
   * streaming an AI reply on this surface. Locks the textarea + send button and
   * shows a banner naming the active streamer. The Stop button is gated separately
   * on `isStreaming` so observers never see a Stop button. */
  remoteStreamingUser?: { userId: string; displayName: string } | null;
  /**
   * The conversation's queued messages (issue #2676), in dispatch order — the
   * tray above the composer renders this list. Absent = the queue is not
   * wired on this surface and Enter during a stream stays inert, as before.
   */
  queuedMessages?: UIMessage[];
  /**
   * Queue the composer's text while streaming. Presence is what lets
   * `handleSend`/`canSend` through during a stream; the surface clears the
   * composer text when enqueueing succeeds.
   */
  onEnqueue?: () => void;
  /** Remove one queued message (tray row button). */
  onRemoveQueued?: (messageId: string) => void;
  /** Remove every queued message (tray clear-all). */
  onClearQueued?: () => void;
  /** Double-ESC interrupt: clear the queue and cancel the pending drain. */
  onCancelQueue?: () => void;
  /** The queue is at its cap — surfaced in the tray and the queue-send button. */
  isQueueFull?: boolean;
}

export interface ChatInputRef {
  /** Focus the input */
  focus: () => void;
  /** Clear the input */
  clear: () => void;
}

/**
 * ChatInput - Composed input component for AI chat
 *
 * Combines:
 * - ChatTextarea with @ mention support
 * - InputActions (send/stop buttons)
 * - AttachButton + AttachmentPreviewStrip (vision support)
 * - Read-only indicator when applicable
 *
 * This component provides the inner content for InputCard.
 * It does NOT include the card styling - that's handled by ChatLayout.
 */
export const ChatInput = forwardRef<ChatInputRef, ChatInputProps>(
  (
    {
      value,
      onChange,
      onSend,
      onStop,
      onSideQuestion,
      isStreaming,
      isStopping = false,
      disabled = false,
      placeholder = 'Type your message...',
      driveId,
      commandDriveId,
      crossDrive = false,
      hideModelSelector = false,
      variant = 'main',
      showToolApprovalSettings = false,
      mcpRunningServers = 0,
      mcpServerNames = [],
      mcpEnabledCount = 0,
      mcpAllEnabled = false,
      onMcpToggleAll,
      isMcpServerEnabled,
      onMcpServerToggle,
      showMcp = false,
      popupPlacement = 'top',
      selectedProvider: propProvider,
      selectedModel: propModel,
      onProviderModelChange,
      attachments,
      onAddFiles,
      onRemoveFile,
      hasVision = false,
      remoteStreamingUser = null,
      queuedMessages,
      onEnqueue,
      onRemoveQueued,
      onClearQueued,
      onCancelQueue,
      isQueueFull = false,
    },
    ref
  ) => {
    const effectiveDisabled = disabled || remoteStreamingUser !== null;
    const textareaRef = useRef<ChatTextareaRef>(null);

    // Get settings from centralized store
    const webSearchEnabled = useAssistantSettingsStore((s) => s.webSearchEnabled);
    const imageGenEnabled = useAssistantSettingsStore((s) => s.imageGenEnabled);
    const isAdmin = useAssistantSettingsStore((s) => s.isAdmin);
    const writeMode = useAssistantSettingsStore((s) => s.writeMode);
    const showPageTree = useAssistantSettingsStore((s) => s.showPageTree);
    const toggleWebSearch = useAssistantSettingsStore((s) => s.toggleWebSearch);
    const toggleImageGen = useAssistantSettingsStore((s) => s.toggleImageGen);
    const toggleWriteMode = useAssistantSettingsStore((s) => s.toggleWriteMode);
    const toggleShowPageTree = useAssistantSettingsStore((s) => s.toggleShowPageTree);
    const toolApprovalSettings = useToolApprovalSettings({ enabled: showToolApprovalSettings });
    const storeProvider = useAssistantSettingsStore((s) => s.currentProvider);
    const storeModel = useAssistantSettingsStore((s) => s.currentModel);
    const setProviderSettings = useAssistantSettingsStore((s) => s.setProviderSettings);
    const loadSettings = useAssistantSettingsStore((s) => s.loadSettings);

    // Use props if provided, otherwise fallback to store
    const currentProvider = propProvider ?? storeProvider;
    const currentModel = propModel ?? storeModel;
    const handleProviderModelChange = onProviderModelChange ?? setProviderSettings;

    // Load settings on mount. Even when provider/model come from props (page-AI
    // chat), we still need the store's isAdmin flag so the admin-gated Image toggle
    // reflects the user's access. loadSettings is idempotent (guarded by
    // isInitialized) and page-AI keeps using its own provider props for the selector.
    useEffect(() => {
      loadSettings();
    }, [loadSettings]);

    // Speech recognition
    const { isListening, isSupported, error: speechError, toggleListening, clearError: clearSpeechError } = useSpeechRecognition({
      onTranscript: (text) => {
        const newValue = value + (value ? ' ' : '') + text;
        onChange(newValue);
      },
    });

    // Mobile keyboard management
    const keyboard = useMobileKeyboard();
    const prevStreamingRef = useRef(isStreaming);

    // Dismiss keyboard when streaming starts
    useEffect(() => {
      if (isStreaming && !prevStreamingRef.current) {
        keyboard.dismiss();
      }
      prevStreamingRef.current = isStreaming;
    }, [isStreaming, keyboard]);

    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      clear: () => textareaRef.current?.clear(),
    }));

    const hasText = value.trim().length > 0;
    const hasImages = (attachments?.length ?? 0) > 0;
    const isSideQuestion = /^\/btw\s+\S/.test(value.trim());
    const queueWired = onEnqueue !== undefined;

    // Issue #2676: during a stream the send verb is QUEUE, so the gate is no
    // longer `!isStreaming` — only the observer lock (`effectiveDisabled`)
    // blocks, exactly as before. Attachments still never send mid-stream.
    const canSend = (hasText || hasImages) && !effectiveDisabled && (!isStreaming || queueWired);
    // Queued = text-only v1: images keep their existing disabled-during-stream rule.
    const canQueue = queueWired && hasText && !hasImages && !effectiveDisabled && !isQueueFull;

    const handleSend = () => {
      if (effectiveDisabled) return;
      if (!hasText && !hasImages) return;

      if (!isStreaming) {
        keyboard.dismiss();
        if (isSideQuestion && onSideQuestion) onSideQuestion(); else onSend();
        return;
      }

      // Streaming: a detached /btw stays a side question; anything else is
      // QUEUED — never a second POST while the turn is live. The surface
      // clears the composer when enqueueing succeeds.
      if (isSideQuestion && onSideQuestion) {
        keyboard.dismiss();
        onSideQuestion();
        return;
      }
      if (!canQueue) return;
      keyboard.dismiss();
      onEnqueue();
    };

    // ESC during a stream = Stop (useStopStream -> /api/ai/abort); the abort's
    // terminal event then drains the queue automatically. A second ESC within
    // the window — or while the stop is still resolving — is the stronger
    // interrupt: clear the queue and cancel that pending drain. Not
    // streaming, the key keeps whatever behavior it had (suggestion pickers).
    // Suggestion/mention pickers consume Escape with stopPropagation upstream,
    // so a picker close never stops a stream.
    const lastEscapeAtRef = useRef(0);
    const handleComposerKeyDown = (e: React.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (!isStreaming) return;
      e.preventDefault();
      const now = Date.now();
      if (isStopping || now - lastEscapeAtRef.current < DOUBLE_ESC_INTERRUPT_MS) {
        lastEscapeAtRef.current = 0;
        onCancelQueue?.();
        return;
      }
      lastEscapeAtRef.current = now;
      onStop();
    };

    // Drag-and-drop handler for images
    const handleDragOver = useCallback((e: React.DragEvent) => {
      if (!onAddFiles || !hasVision) return;
      e.preventDefault();
      e.stopPropagation();
    }, [onAddFiles, hasVision]);

    const handleDrop = useCallback((e: React.DragEvent) => {
      if (!onAddFiles || !hasVision) return;
      e.preventDefault();
      e.stopPropagation();

      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
      if (files.length > 0) {
        onAddFiles(files);
      }
    }, [onAddFiles, hasVision]);

    return (
      <div
        className={cn('flex flex-col relative min-w-0')}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onKeyDown={handleComposerKeyDown}
      >
        {/* Attachment preview strip (shown when images are attached) */}
        {attachments && attachments.length > 0 && onRemoveFile && (
          <AttachmentPreviewStrip
            attachments={attachments}
            onRemove={onRemoveFile}
          />
        )}

        {remoteStreamingUser && (
          <div
            className="flex items-center gap-2 px-3 pt-2 pb-1 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            <Lock className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {remoteStreamingUser.displayName} is chatting with the AI…
            </span>
          </div>
        )}

        {/* Send queue (issue #2676): visible, ordered, editable — a queued send
            must never feel like a swallowed one. */}
        {queueWired && (
          <QueueTray
            messages={queuedMessages ?? []}
            onRemove={onRemoveQueued ?? (() => {})}
            onClear={onClearQueued ?? (() => {})}
            isQueueFull={isQueueFull}
            className="mx-3 mb-1"
          />
        )}

        {/* Input row */}
        <div className="flex items-start gap-2 p-3 min-w-0">
          {/* Attach button (shown when model supports vision) */}
          {hasVision && onAddFiles && (
            <AttachButton
              onFiles={onAddFiles}
              disabled={isStreaming || effectiveDisabled}
            />
          )}

          <ChatTextarea
            ref={textareaRef}
            value={value}
            onChange={onChange}
            onSend={handleSend}
            placeholder={placeholder}
            driveId={driveId}
            commandDriveId={commandDriveId}
            // ChatInput owns the /btw interception gate (handleSend), so it —
            // and only it among the composer surfaces — may offer client-
            // handled commands, and only while that handler is wired.
            // ChannelInput and other bare ChatTextarea consumers stay gated
            // off and are never offered /btw.
            allowClientHandledCommands={Boolean(onSideQuestion)}
            crossDrive={crossDrive}
            disabled={effectiveDisabled}
            variant={variant}
            popupPlacement={popupPlacement}
            onPasteFiles={hasVision && onAddFiles ? onAddFiles : undefined}
          />

          <InputActions
            isStreaming={isStreaming}
            isStopping={isStopping}
            onSend={handleSend}
            onStop={onStop}
            disabled={!canSend}
            onQueueSend={queueWired ? handleSend : undefined}
            canQueue={canQueue}
            queuedCount={queuedMessages?.length ?? 0}
            isQueueFull={isQueueFull}
          />
        </div>

        {/* Footer menu */}
        <InputFooter
          webSearchEnabled={webSearchEnabled}
          onWebSearchToggle={toggleWebSearch}
          imageGenEnabled={imageGenEnabled}
          onImageGenToggle={toggleImageGen}
          canUseImageGen={isImageGenerationAllowed(isAdmin)}
          writeMode={writeMode}
          onWriteModeToggle={toggleWriteMode}
          toolApprovalMode={showToolApprovalSettings ? toolApprovalSettings.mode : undefined}
          onToolApprovalModeToggle={(ask) => void toolApprovalSettings.setMode(ask ? 'ask' : 'auto')}
          trustedTools={showToolApprovalSettings ? toolApprovalSettings.grants : undefined}
          onRevokeTrustedTool={(grantId) => void toolApprovalSettings.revokeGrant(grantId)}
          showPageTree={showPageTree}
          onShowPageTreeToggle={toggleShowPageTree}
          mcpRunningServers={mcpRunningServers}
          mcpServerNames={mcpServerNames}
          mcpEnabledCount={mcpEnabledCount}
          mcpAllEnabled={mcpAllEnabled}
          onMcpToggleAll={onMcpToggleAll}
          isMcpServerEnabled={isMcpServerEnabled}
          onMcpServerToggle={onMcpServerToggle}
          showMcp={showMcp}
          onMicClick={toggleListening}
          isListening={isListening}
          isMicSupported={isSupported}
          micError={speechError}
          onClearMicError={clearSpeechError}
          selectedProvider={currentProvider}
          selectedModel={currentModel}
          onProviderModelChange={handleProviderModelChange}
          hideModelSelector={hideModelSelector}
          disabled={isStreaming || effectiveDisabled}
        />
      </div>
    );
  }
);

ChatInput.displayName = 'ChatInput';
