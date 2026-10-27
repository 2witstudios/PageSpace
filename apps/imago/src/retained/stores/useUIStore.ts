import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface UIState {
  // Tree state (PERSISTED)
  treeExpanded: Set<string>;
  treeScrollPosition: number;

  // Quick-create palette state (NOT persisted)
  quickCreateOpen: boolean;
  /**
   * Three-state parent placement:
   *   undefined → auto-detect from the current route (folder → child, page → sibling, root → top-level)
   *   null      → force creation at the drive root
   *   string    → create as a child of this specific page id
   *
   * Callers with a `string | null` variable should be explicit: pass `undefined` to use auto-detect
   * rather than accidentally mapping a null "no page" to "drive root".
   */
  quickCreateParentOverride: string | null | undefined;
  /**
   * The control that opened the palette (the Files pane "+"). When set, the palette anchors
   * under it as a popover; when null, it opens as the centred dialog. Not persisted.
   */
  quickCreateAnchor: HTMLElement | null;

  // Actions
  setTreeExpanded: (nodeId: string, expanded: boolean) => void;
  setTreeScrollPosition: (position: number) => void;
  /** @see quickCreateParentOverride for parentOverride semantics */
  openQuickCreate: (parentOverride?: string | null, anchor?: HTMLElement | null) => void;
  closeQuickCreate: () => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      // Initial state
      treeExpanded: new Set(),
      treeScrollPosition: 0,
      quickCreateOpen: false,
      quickCreateParentOverride: undefined,
      quickCreateAnchor: null,

      // Actions
      setTreeExpanded: (nodeId: string, expanded: boolean) => {
        const newExpanded = new Set(get().treeExpanded);
        if (expanded) {
          newExpanded.add(nodeId);
        } else {
          newExpanded.delete(nodeId);
        }
        set({ treeExpanded: newExpanded });
      },

      setTreeScrollPosition: (position: number) => {
        set({ treeScrollPosition: position });
      },

      openQuickCreate: (parentOverride?: string | null, anchor?: HTMLElement | null) => {
        set({ quickCreateOpen: true, quickCreateParentOverride: parentOverride, quickCreateAnchor: anchor ?? null });
      },

      closeQuickCreate: () => {
        set({ quickCreateOpen: false, quickCreateParentOverride: undefined, quickCreateAnchor: null });
      },
    }),
    {
      name: 'ui-store',
      partialize: (state) => ({
        treeExpanded: Array.from(state.treeExpanded),
        treeScrollPosition: state.treeScrollPosition,
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.treeExpanded) {
          const expanded = state.treeExpanded;
          state.treeExpanded = new Set(Array.isArray(expanded) ? expanded : Array.from(expanded as Set<string>));
        }
      },
    }
  )
);
