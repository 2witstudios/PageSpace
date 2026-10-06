import type { UiSlice, UiState } from '../store/state';

type PaletteResources = {
  /** The ⌘K palette is showing. */
  readonly paletteOpen: boolean;
  /** What the palette's field holds. */
  readonly paletteQuery: string;
  /** "Include all workspaces": search every drive the viewer can reach, not the open one. */
  readonly paletteAllDrives: boolean;
  /** The highlighted result, by its place in the list Enter would open. */
  readonly paletteActive: number;
};

const withPalette = (state: UiState, palette: Partial<PaletteResources>): UiState => ({
  ...state,
  resources: { ...state.resources, ...palette },
});

/**
 * The command palette's view state. Each opening starts from an empty field
 * with the first result highlighted; whether it searches every drive is the
 * viewer's to keep while the tab lives. The results themselves are the
 * server's and never live here.
 */
export const palettePlugin = {
  resources: (): PaletteResources => ({
    paletteOpen: false,
    paletteQuery: '',
    paletteAllDrives: false,
    paletteActive: 0,
  }),
  transactions: {
    openPalette: (state: UiState, _: void): UiState =>
      state.resources.paletteOpen ? state : withPalette(state, { paletteOpen: true, paletteQuery: '', paletteActive: 0 }),
    closePalette: (state: UiState, _: void): UiState =>
      state.resources.paletteOpen ? withPalette(state, { paletteOpen: false, paletteQuery: '', paletteActive: 0 }) : state,
    /** A new query is a new list: the highlight goes back to its top. */
    setPaletteQuery: (state: UiState, paletteQuery: string): UiState =>
      state.resources.paletteQuery === paletteQuery ? state : withPalette(state, { paletteQuery, paletteActive: 0 }),
    togglePaletteAllDrives: (state: UiState, _: void): UiState =>
      withPalette(state, { paletteAllDrives: !state.resources.paletteAllDrives, paletteActive: 0 }),
    /**
     * Moves the highlight `by` rows through `count` results, wrapping at
     * either end as a listbox does; with nothing listed it stays at the top.
     */
    movePaletteActive: (state: UiState, { by, count }: { readonly by: number; readonly count: number }): UiState => {
      const next = count > 0 ? (((state.resources.paletteActive + by) % count) + count) % count : 0;
      return next === state.resources.paletteActive ? state : withPalette(state, { paletteActive: next });
    },
    /** The pointer is over a row: it is the one Enter opens. */
    setPaletteActive: (state: UiState, paletteActive: number): UiState =>
      state.resources.paletteActive === paletteActive ? state : withPalette(state, { paletteActive }),
  },
} satisfies UiSlice;
