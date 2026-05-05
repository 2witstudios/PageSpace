'use client';

/**
 * MessageInput
 *
 * Thin wrapper around `ChannelInput` that exposes a source-aware composer for
 * channels, DMs, and threads. The wrapper itself is presentational — it picks
 * the right upload target (channelId vs conversationId), assembles the
 * editing-store session key (so unsent drafts survive SWR refreshes), and
 * forwards `parentId` / "also send to parent" props through to the input.
 *
 * Send orchestration (optimistic insert, POST, rollback) lives on the page or
 * panel that owns the message list — each surface has its own reconciliation
 * strategy and we keep them in their own files. Callers receive a fully
 * shaped `onSubmit({ content, attachment, alsoSendToParent })` callback.
 */

import { forwardRef, useCallback } from 'react';
import {
  ChannelInput,
  type ChannelInputRef,
  type ChannelInputSendOptions,
  type FileAttachment,
} from '@/components/layout/middle-content/page-views/channel/ChannelInput';

export type MessageInputSource = 'channel' | 'dm';

export interface MessageInputSubmit {
  content: string;
  attachment?: FileAttachment;
  alsoSendToParent: boolean;
}

export interface MessageInputProps {
  /** Which surface is composing — picks editing-store key namespace and upload target */
  source: MessageInputSource;
  /** pageId for `channel`, conversationId for `dm` */
  contextId: string;
  /** Current input value */
  value: string;
  /** Input change handler */
  onChange: (value: string) => void;
  /** Called when the user attempts to send — caller does optimistic update + POST */
  onSubmit: (info: MessageInputSubmit) => void;
  /** Drive ID (channel only — used for mention suggestions) */
  driveId?: string;
  /** Whether attachments are enabled */
  attachmentsEnabled?: boolean;
  /** Thread root id — set when this composer is rendered inside ThreadPanel */
  parentId?: string;
  /** Render the "Also send to channel/DM" checkbox in the footer (thread mode only) */
  showAlsoSendToParent?: boolean;
  /** Placeholder text */
  placeholder?: string;
}

/**
 * Stable session key for useEditingStore. Includes the parentId so a
 * top-level draft and a thread draft on the same page do not share state.
 */
export const buildEditingSessionKey = (
  source: MessageInputSource,
  contextId: string,
  parentId?: string,
): string =>
  parentId
    ? `thread:${source}:${contextId}:${parentId}`
    : `compose:${source}:${contextId}`;

export const MessageInput = forwardRef<ChannelInputRef, MessageInputProps>(
  function MessageInput(
    {
      source,
      contextId,
      value,
      onChange,
      onSubmit,
      driveId,
      attachmentsEnabled = true,
      parentId,
      showAlsoSendToParent = false,
      placeholder,
    },
    ref,
  ) {
    const handleSend = useCallback(
      (attachment?: FileAttachment, options?: ChannelInputSendOptions) => {
        const content = value;
        if (!content.trim() && !attachment) return;
        onSubmit({
          content,
          attachment,
          alsoSendToParent: Boolean(options?.alsoSendToParent),
        });
      },
      [value, onSubmit],
    );

    return (
      <ChannelInput
        ref={ref}
        value={value}
        onChange={onChange}
        onSend={handleSend}
        placeholder={
          placeholder ?? 'Type a message... (use @ to mention, supports **markdown**)'
        }
        driveId={source === 'channel' ? driveId : undefined}
        channelId={source === 'channel' ? contextId : undefined}
        conversationId={source === 'dm' ? contextId : undefined}
        attachmentsEnabled={attachmentsEnabled}
        parentId={parentId}
        showAlsoSendToParent={showAlsoSendToParent}
        editingSessionKey={buildEditingSessionKey(source, contextId, parentId)}
      />
    );
  },
);

export default MessageInput;
