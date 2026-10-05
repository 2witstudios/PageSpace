import { create } from 'zustand';

/**
 * Which conversation the header's spending-from chip speaks for (Spec UI-8, SPEND-2). The header
 * is global chrome; the source is chosen per conversation (SPEND-3), so the chat surface in view
 * registers its conversation here and the chip reads it. The latest registration wins (the chat
 * the person last opened or focused); unregistering only clears the entry it set.
 */
export interface SpendContext {
  conversationId: string;
  /** The drive the conversation spends in; for a global conversation, the drive the person is in. */
  driveId: string | null;
  /** A global (assistant) conversation names its drive on the preview request (?driveId=). */
  isGlobal: boolean;
  /** Whether the conversation already has messages (the composer strip shows only before the first). */
  hasMessages: boolean;
}

interface SpendContextState {
  active: SpendContext | null;
  /** Set the active conversation; returns an unregister that clears it only if it is still this one. */
  register: (context: SpendContext) => () => void;
  /** The popover the chip opens, so a "Change" link elsewhere (strip, fallback notice) can open it. */
  popoverOpen: boolean;
  setPopoverOpen: (open: boolean) => void;
}

export const useSpendContextStore = create<SpendContextState>((set, get) => ({
  active: null,
  register: (context) => {
    set({ active: context });
    return () => {
      const current = get().active;
      if (current && current.conversationId === context.conversationId) set({ active: null });
    };
  },
  popoverOpen: false,
  setPopoverOpen: (open) => set({ popoverOpen: open }),
}));
