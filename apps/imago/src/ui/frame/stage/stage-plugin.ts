import type { UiSlice, UiState } from '../../store/state';
import type { HideableSection } from './stage';

const withImago = (state: UiState, patch: { imagoCollapsed?: boolean; imagoClosed?: boolean }): UiState => {
  const { imagoCollapsed, imagoClosed } = { ...state.resources, ...patch };
  return imagoCollapsed === state.resources.imagoCollapsed && imagoClosed === state.resources.imagoClosed
    ? state
    : { ...state, resources: { ...state.resources, imagoCollapsed, imagoClosed } };
};

const withCollapsed = (state: UiState, collapsedSections: readonly HideableSection[]): UiState => ({
  ...state,
  resources: { ...state.resources, collapsedSections },
});

const withPaneSheet = (state: UiState, paneSheetOpen: boolean): UiState =>
  state.resources.paneSheetOpen === paneSheetOpen ? state : { ...state, resources: { ...state.resources, paneSheetOpen } };

/**
 * The stage itself lives in the URL; the store holds only which sections'
 * panes the viewer hid and where they put Imago (IMC-1.3). Both transactions return the same snapshot when
 * nothing changes, so a repeated click re-renders nothing.
 */
export const stagePlugin = {
  resources: (): {
    /** Sections whose list the viewer hid; the stage itself lives in the URL. */
    readonly collapsedSections: readonly HideableSection[];
    /** Imago docked beside a page is folded to the Ask pill (IMC-1.3). */
    readonly imagoCollapsed: boolean;
    /** Imago was closed while it filled the middle: the empty middle shows. */
    readonly imagoClosed: boolean;
    /** Below 1024px the pane is a left sheet, closed until Show sidebar opens it (IMC-11.1). */
    readonly paneSheetOpen: boolean;
  } => ({ collapsedSections: [], imagoCollapsed: false, imagoClosed: false, paneSheetOpen: false }),
  transactions: {
    collapseSection: (state: UiState, section: HideableSection): UiState =>
      withPaneSheet(
        state.resources.collapsedSections.includes(section)
          ? state
          : withCollapsed(state, [...state.resources.collapsedSections, section]),
        false,
      ),
    expandSection: (state: UiState, section: HideableSection): UiState =>
      withPaneSheet(
        state.resources.collapsedSections.includes(section)
          ? withCollapsed(
              state,
              state.resources.collapsedSections.filter((entry) => entry !== section),
            )
          : state,
        true,
      ),
    /** The narrow pane sheet closes on navigation and on its scrim. */
    closePaneSheet: (state: UiState): UiState => withPaneSheet(state, false),
    collapseImago: (state: UiState): UiState => withImago(state, { imagoCollapsed: true }),
    expandImago: (state: UiState): UiState => withImago(state, { imagoCollapsed: false }),
    closeImago: (state: UiState): UiState => withImago(state, { imagoClosed: true }),
    /** Ask Imago: open it, docked or on the ground, whatever hid it. */
    openImago: (state: UiState): UiState => withImago(state, { imagoCollapsed: false, imagoClosed: false }),
  },
} satisfies UiSlice;
