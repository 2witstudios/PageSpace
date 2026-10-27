'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useImageAttachments } from '@/retained/lib/ai/shared/hooks/useImageAttachments';

type Attachments = ReturnType<typeof useImageAttachments>;
const ChatAttachments = createContext<Attachments | null>(null);

/** One attachment owner above object navigation and conversation selection. */
export function ChatAttachmentsProvider({ children }: { children: ReactNode }) {
  const attachments = useImageAttachments();
  return <ChatAttachments.Provider value={attachments}>{children}</ChatAttachments.Provider>;
}
export function useChatAttachments() {
  const attachments = useContext(ChatAttachments);
  if (!attachments) throw new Error('Chat attachments require the retained provider');
  return attachments;
}
