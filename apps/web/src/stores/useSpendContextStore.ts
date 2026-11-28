import { create } from 'zustand';

/**
 * Which conversation the header's spending-from chip speaks for (Spec UI-8, SPEND-2). The header
 * is global chrome; the source is chosen per conversation (SPEND-3), so each mounted chat surface
 * registers its conversation here and the chip shows the one the person last focused.
 *
 * READ-ONLY for everything but the header chip: a surface's own spend controls (the composer
 * strip, the refusal card, the fallback notice) take their conversation from the surface that
 * rendered them (SpendSurfaceProvider), never from here, so a write can only ever target the
 * conversation the control belongs to (review #2835 P1-1). The header chip writes to the exact
 * conversation it displays.
 *
 * Surfaces are kept in focus order (most recent last), so when the focused surface unmounts the
 * header falls back to the one focused before it, not to nothing.
 */
export interface SpendContext {
  conversationId: string;
  /** The drive the conversation spends in; for a global conversation, the drive the person is in. */
  driveId: string | null;
  /** A global (assistant) conversation names its drive on the preview request (?driveId=). */
  isGlobal: boolean;
}

interface SpendContextEntry extends SpendContext {
  /** Identifies the mounted surface (two surfaces may show the same conversation). */
  surfaceId: string;
}

interface SpendContextState {
  /** Mounted surfaces, least recently focused first. */
  entries: SpendContextEntry[];
  /** The surface the header chip follows: the most recently focused one. */
  active: SpendContext | null;
  /**
   * Add a surface (at the back of the focus order) or update it IN PLACE: a surface whose
   * conversation or drive changes keeps its position, so only real focus moves it (review #2835
   * P2-A). Returns its unregister.
   */
  register: (surfaceId: string, context: SpendContext) => () => void;
  /** Remove a surface (it unmounted, or has no conversation). */
  unregister: (surfaceId: string) => void;
  /** Move a surface to the front: the person focused or clicked inside it. */
  focus: (surfaceId: string) => void;
}

const activeOf = (entries: SpendContextEntry[]): SpendContext | null => {
  const last = entries[entries.length - 1];
  return last ? { conversationId: last.conversationId, driveId: last.driveId, isGlobal: last.isGlobal } : null;
};

export const useSpendContextStore = create<SpendContextState>((set, get) => ({
  entries: [],
  active: null,
  register: (surfaceId, context) => {
    const existing = get().entries;
    const entry: SpendContextEntry = { surfaceId, ...context };
    const entries = existing.some((e) => e.surfaceId === surfaceId)
      ? existing.map((e) => (e.surfaceId === surfaceId ? entry : e))
      : [...existing, entry];
    set({ entries, active: activeOf(entries) });
    return () => get().unregister(surfaceId);
  },
  unregister: (surfaceId) => {
    const remaining = get().entries.filter((e) => e.surfaceId !== surfaceId);
    set({ entries: remaining, active: activeOf(remaining) });
  },
  focus: (surfaceId) => {
    const { entries } = get();
    const entry = entries.find((e) => e.surfaceId === surfaceId);
    if (!entry || entries[entries.length - 1]?.surfaceId === surfaceId) return;
    const reordered = [...entries.filter((e) => e.surfaceId !== surfaceId), entry];
    set({ entries: reordered, active: activeOf(reordered) });
  },
}));
