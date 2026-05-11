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
  /** Author + snippet for the quote-reply chip rendered above the input row.
      Parent owns the active quoted message id; this prop only drives the chip UI. */
  quotedPreview?: { authorName: string; snippet: string } | null;
  /** Dismiss the active quote — invoked when the user clicks the chip's X. */
  onClearQuote?: () => void;
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
      quotedPreview,
      onClearQuote,
    },
    ref,
  ) {
    const handleSend = useCallback(
      (attachments?: FileAttachment[], options?: ChannelInputSendOptions) => {
        const content = value;
        if (!content.trim() && (!attachments || attachments.length === 0)) return;

        const [first, ...rest] = attachments ?? [];

        // First (or only) message carries the composed text + first file
        onSubmit({
          content,
          attachment: first,
          alsoSendToParent: Boolean(options?.alsoSendToParent),
        });

        // Additional files each become their own message with empty text
        for (const extra of rest) {
          onSubmit({ content: '', attachment: extra, alsoSendToParent: false });
        }
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
        crossDrive={source === 'dm'}
        channelId={source === 'channel' ? contextId : undefined}
        conversationId={source === 'dm' ? contextId : undefined}
        attachmentsEnabled={attachmentsEnabled}
        parentId={parentId}
        showAlsoSendToParent={showAlsoSendToParent}
        editingSessionKey={buildEditingSessionKey(source, contextId, parentId)}
        quotedPreview={quotedPreview}
        onClearQuote={onClearQuote}
      />
    );
  },
);

export default MessageInput;
