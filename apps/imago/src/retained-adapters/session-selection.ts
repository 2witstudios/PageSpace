 'use client';
import { create } from 'zustand';
export type RetainedChatSelection = {
  sessionId: string | null; conversationId: string; agentId: string | null; driveId: string | null; isReadOnly: boolean;
};
export const useRetainedChatSelection = create<{
  selection: RetainedChatSelection | null;
  select: (selection: RetainedChatSelection | null) => void;
}>(set => ({ selection: null, select: selection => set({ selection }) }));
