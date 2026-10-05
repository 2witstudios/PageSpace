import type { UiState } from '../../store/state';
import type { UiPlugin } from '../../store/transactions';
import type { ListSection } from './stage';

const withCollapsed = (state: UiState, collapsedSections: readonly ListSection[]): UiState => ({
  ...state,
  resources: { ...state.resources, collapsedSections },
});

/**
 * The stage itself lives in the URL; the store holds only which sections'
 * lists the viewer hid. Both transactions return the same snapshot when
 * nothing changes, so a repeated click re-renders nothing.
 */
export const stagePlugin = {
  transactions: {
    collapseSection: (state: UiState, section: ListSection): UiState =>
      state.resources.collapsedSections.includes(section)
        ? state
        : withCollapsed(state, [...state.resources.collapsedSections, section]),
    expandSection: (state: UiState, section: ListSection): UiState =>
      state.resources.collapsedSections.includes(section)
        ? withCollapsed(
            state,
            state.resources.collapsedSections.filter((entry) => entry !== section),
          )
        : state,
  },
} satisfies UiPlugin;
