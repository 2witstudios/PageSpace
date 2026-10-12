import type { Stage } from './stage';

/**
 * The view state the URL does not carry (IMC-1.3). Whether a page is open is the URL's
 * (closing the page navigates to its section); these three are the viewer's.
 */
export type ColumnState = {
  /** The viewer closed this stage's left pane. */
  readonly paneCollapsed: boolean;
  /** Imago docked beside a page, collapsed to the page head's Ask pill. */
  readonly imagoCollapsed: boolean;
  /** Imago closed while it was the ground: the middle is empty. */
  readonly imagoClosed: boolean;
};

/** Where Imago is: beside the page, folded to the Ask pill, filling the middle, or gone. */
export type ImagoPlace = 'docked' | 'collapsed' | 'ground' | 'none';

/** The head that carries Show sidebar while the pane is closed: the first visible one. */
export type SidebarOpener = 'page' | 'imago' | 'empty' | null;

export type Columns = {
  readonly pane: boolean;
  readonly page: boolean;
  readonly imago: ImagoPlace;
  readonly showSidebarIn: SidebarOpener;
  /** "Ask" in the page head: only while Imago is collapsed beside a page. */
  readonly askPill: boolean;
  /** Collapse Imago (right-panel icon): only while it is docked. */
  readonly collapseImago: boolean;
  /** Close Imago (×): only while it fills the middle. */
  readonly closeImago: boolean;
  /** Close page (×): whenever a page is open. */
  readonly closePage: boolean;
};

/**
 * C-Files-Doc's `_v32Vals`/`renderVals` (SPEC v3.2): three kinds of column, three controls.
 * The left pane collapses; every middle area closes with ×; Imago docked collapses to the Ask
 * pill. With no page open, Imago is the ground and can be closed, which leaves the empty
 * middle; collapsing never applies there, so a collapse made beside a page is ignored.
 */
export const columnsFor = (stage: Stage, state: ColumnState): Columns => {
  const hasPane = stage.list !== 'closed';
  const pane = hasPane && !state.paneCollapsed;
  const page = stage.object !== null;
  const imago: ImagoPlace = page
    ? state.imagoCollapsed
      ? 'collapsed'
      : 'docked'
    : state.imagoClosed
      ? 'none'
      : 'ground';
  const showSidebarIn: SidebarOpener =
    !hasPane || pane ? null : page ? 'page' : imago === 'none' ? 'empty' : 'imago';
  return {
    pane,
    page,
    imago,
    showSidebarIn,
    askPill: imago === 'collapsed',
    collapseImago: imago === 'docked',
    closeImago: imago === 'ground',
    closePage: page,
  };
};
