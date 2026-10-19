import { floatsOver, type ViewportTier } from '../viewport/viewport-tier';
import { isTasksIndex, type Stage } from './stage';

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

/**
 * Where Imago is: beside the page, a sheet over it (below 1280px it never docks), folded to the
 * Ask pill, filling the middle, or gone.
 */
export type ImagoPlace = 'docked' | 'overlay' | 'collapsed' | 'ground' | 'none';

/** The head that carries Show sidebar while the pane is closed: the first visible one. */
export type SidebarOpener = 'page' | 'imago' | 'empty' | null;

export type Columns = {
  readonly pane: boolean;
  readonly page: boolean;
  readonly imago: ImagoPlace;
  /** The pane floats over the page as a left sheet (below 1024px) instead of docking. */
  readonly paneSheet: boolean;
  readonly showSidebarIn: SidebarOpener;
  /** "Ask" in the page head: only while Imago is collapsed beside a page. */
  readonly askPill: boolean;
  /** Collapse Imago (right-panel icon): only while it is docked or a sheet. */
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
 *
 * Below 1280px (C-Resp-Tablet-Doc) Imago beside a page is a sheet over it rather than a column,
 * and below 1024px the pane is a left sheet too; the controls are the same.
 */
export const columnsFor = (stage: Stage, state: ColumnState, tier: ViewportTier = 'desktop'): Columns => {
  const hasPane = stage.list !== 'closed';
  const pane = hasPane && !state.paneCollapsed;
  // The Tasks index holds its ground in the middle, so Imago sits beside it like beside a page.
  const page = stage.object !== null || isTasksIndex(stage);
  const imago: ImagoPlace = page
    ? state.imagoCollapsed
      ? 'collapsed'
      : floatsOver(tier)
        ? 'overlay'
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
    paneSheet: pane && (tier === 'narrow' || tier === 'phone'),
    showSidebarIn,
    askPill: imago === 'collapsed',
    collapseImago: imago === 'docked' || imago === 'overlay',
    closeImago: imago === 'ground',
    closePage: stage.object !== null,
  };
};
