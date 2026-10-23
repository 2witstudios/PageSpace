import type { UiSlice, UiState } from '../../store/state';
import { toggleGroup } from '../messages-pane/message-groups';

const withCollapsed = (state: UiState, collapsedMessageGroups: readonly string[]): UiState => ({
  ...state,
  resources: { ...state.resources, collapsedMessageGroups },
});

/**
 * The Messages pane's folded groups (saved per browser by useCollapsedGroups).
 * The threads themselves live in SWR, not here.
 */
export const messagesPlugin = {
  resources: (): {
    /** Group keys (message-groups.ts) the viewer folded away. */
    readonly collapsedMessageGroups: readonly string[];
  } => ({ collapsedMessageGroups: [] }),
  transactions: {
    /** The folded groups as this browser saved them. */
    restoreMessageGroups: (state: UiState, collapsed: readonly string[]): UiState => withCollapsed(state, collapsed),
    toggleMessageGroup: (state: UiState, key: string): UiState =>
      withCollapsed(state, toggleGroup(state.resources.collapsedMessageGroups, key)),
  },
} satisfies UiSlice;
