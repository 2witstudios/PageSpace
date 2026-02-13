'use client';

import React, { forwardRef, useRef, useImperativeHandle, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { ChatTextarea, type ChatTextareaRef } from './ChatTextarea';
import { InputActions } from './InputActions';
import { AttachButton } from './AttachButton';
import { AttachmentPreviewStrip } from './AttachmentPreviewStrip';
import { InputFooter } from '@/components/ui/floating-input';
import { useAssistantSettingsStore } from '@/stores/useAssistantSettingsStore';
import { useSpeechRecognition } from '@/hooks/useSpeechRecognition';
import { useMobileKeyboard } from '@/hooks/useMobileKeyboard';
import type { ImageAttachment } from '@/lib/ai/shared/hooks/useImageAttachments';

export interface ChatInputProps {
  /** Current input value */
  value: string;
  /** Input change handler */
  onChange: (value: string) => void;
  /** Send message handler */
  onSend: () => void;
  /** Stop streaming handler */
  onStop: () => void;
  /** Whether AI is currently streaming */
  isStreaming: boolean;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Placeholder text */
  placeholder?: string;
  /** Drive ID for mention suggestions */
  driveId?: string;
  /** Enable cross-drive mention search */
  crossDrive?: boolean;
  /** Hide the model/provider selector in footer (for compact layouts) */
  hideModelSelector?: boolean;
  /** Style variant: 'main' for InputCard context, 'sidebar' for sidebar contrast */
  variant?: 'main' | 'sidebar';
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
  /** Callback when voice mode button is clicked */
  onVoiceModeClick?: () => void;
  /** Whether voice mode is currently active */
  isVoiceModeActive?: boolean;
  /** Whether voice mode is available (user has OpenAI key) */
  isVoiceModeAvailable?: boolean;
  /** Image attachments for vision support */
  attachments?: ImageAttachment[];
  /** Handler to add image files */
  onAddFiles?: (files: File[]) => void;
  /** Handler to remove an image attachment */
  onRemoveFile?: (id: string) => void;
  /** Whether the current model supports vision */
  hasVision?: boolean;
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
      isStreaming,
      disabled = false,
      placeholder = 'Type your message...',
      driveId,
      crossDrive = false,
      hideModelSelector = false,
      variant = 'main',
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
      onVoiceModeClick,
      isVoiceModeActive = false,
      isVoiceModeAvailable = false,
      attachments,
      onAddFiles,
      onRemoveFile,
      hasVision = false,
    },
    ref
  ) => {
    const textareaRef = useRef<ChatTextareaRef>(null);

    // Get settings from centralized store
    const webSearchEnabled = useAssistantSettingsStore((s) => s.webSearchEnabled);
    const writeMode = useAssistantSettingsStore((s) => s.writeMode);
    const showPageTree = useAssistantSettingsStore((s) => s.showPageTree);
    const toggleWebSearch = useAssistantSettingsStore((s) => s.toggleWebSearch);
    const toggleWriteMode = useAssistantSettingsStore((s) => s.toggleWriteMode);
    const toggleShowPageTree = useAssistantSettingsStore((s) => s.toggleShowPageTree);
    const storeProvider = useAssistantSettingsStore((s) => s.currentProvider);
    const storeModel = useAssistantSettingsStore((s) => s.currentModel);
    const setProviderSettings = useAssistantSettingsStore((s) => s.setProviderSettings);
    const loadSettings = useAssistantSettingsStore((s) => s.loadSettings);

    // Use props if provided, otherwise fallback to store
    const currentProvider = propProvider ?? storeProvider;
    const currentModel = propModel ?? storeModel;
    const handleProviderModelChange = onProviderModelChange ?? setProviderSettings;

    // Load settings on mount (only needed when not using props)
    useEffect(() => {
      if (propProvider === undefined) {
        loadSettings();
      }
    }, [loadSettings, propProvider]);

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

    const handleSend = () => {
      const hasText = value.trim().length > 0;
      const hasImages = (attachments?.length ?? 0) > 0;
      if ((hasText || hasImages) && !disabled) {
        keyboard.dismiss();
        onSend();
      }
    };

    const canSend = (value.trim().length > 0 || (attachments?.length ?? 0) > 0) && !disabled;

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
      >
        {/* Attachment preview strip (shown when images are attached) */}
        {attachments && attachments.length > 0 && onRemoveFile && (
          <AttachmentPreviewStrip
            attachments={attachments}
            onRemove={onRemoveFile}
          />
        )}

        {/* Input row */}
        <div className="flex items-start gap-2 p-3 min-w-0">
          {/* Attach button (shown when model supports vision) */}
          {hasVision && onAddFiles && (
            <AttachButton
              onFiles={onAddFiles}
              disabled={isStreaming || disabled}
            />
          )}

          <ChatTextarea
            ref={textareaRef}
            value={value}
            onChange={onChange}
            onSend={handleSend}
            placeholder={placeholder}
            driveId={driveId}
            crossDrive={crossDrive}
            disabled={disabled}
            variant={variant}
            popupPlacement={popupPlacement}
            onPasteFiles={hasVision && onAddFiles ? onAddFiles : undefined}
          />

          <InputActions
            isStreaming={isStreaming}
            onSend={handleSend}
            onStop={onStop}
            disabled={!canSend}
          />
        </div>

        {/* Footer menu */}
        <InputFooter
          webSearchEnabled={webSearchEnabled}
          onWebSearchToggle={toggleWebSearch}
          writeMode={writeMode}
          onWriteModeToggle={toggleWriteMode}
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
          onVoiceModeClick={onVoiceModeClick}
          isVoiceModeActive={isVoiceModeActive}
          isVoiceModeAvailable={isVoiceModeAvailable}
          selectedProvider={currentProvider}
          selectedModel={currentModel}
          onProviderModelChange={handleProviderModelChange}
          hideModelSelector={hideModelSelector}
          disabled={isStreaming || disabled}
        />
      </div>
    );
  }
);

ChatInput.displayName = 'ChatInput';

export default ChatInput;
