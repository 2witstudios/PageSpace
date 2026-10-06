import type { UiSlice, UiState } from '../../store/state';
import type { HideableSection } from './stage';

const withCollapsed = (state: UiState, collapsedSections: readonly HideableSection[]): UiState => ({
  ...state,
  resources: { ...state.resources, collapsedSections },
});

/**
 * The stage itself lives in the URL; the store holds only which sections'
 * lists the viewer hid. Both transactions return the same snapshot when
 * nothing changes, so a repeated click re-renders nothing.
 */
export const stagePlugin = {
  resources: (): {
    /** Sections whose list the viewer hid; the stage itself lives in the URL. */
    readonly collapsedSections: readonly HideableSection[];
  } => ({ collapsedSections: [] }),
  transactions: {
    collapseSection: (state: UiState, section: HideableSection): UiState =>
      state.resources.collapsedSections.includes(section)
        ? state
        : withCollapsed(state, [...state.resources.collapsedSections, section]),
    expandSection: (state: UiState, section: HideableSection): UiState =>
      state.resources.collapsedSections.includes(section)
        ? withCollapsed(
            state,
            state.resources.collapsedSections.filter((entry) => entry !== section),
          )
        : state,
  },
} satisfies UiSlice;
