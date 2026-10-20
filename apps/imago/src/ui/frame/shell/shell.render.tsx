import type { ReactNode } from 'react';
import type { Columns } from '../stage/columns';
import type { PaneLayout, Stage } from '../stage/stage';
import { Pane } from '../pane/pane';
import type { ViewportTier } from '../viewport/viewport-tier';
import {
  chatSlotClass,
  columnsRowClass,
  emptySlotClass,
  listSlotClass,
  objectSlotClass,
  railClass,
  scrimClass,
  shellClass,
  stageSheetClass,
} from './shell-class';

export type ShellRenderProps = {
  readonly stage: Stage;
  readonly layout: PaneLayout;
  readonly columns: Columns;
  /** React has hydrated the shell, so its controls act. */
  readonly hydrated: boolean;
  readonly rail: ReactNode;
  /** The 36px banner strip above the tab bar: offline, conflicts and other notices by priority. */
  readonly banner: ReactNode;
  /** The 40px open-pages tab bar across the top of the stage sheet. */
  readonly tabBar: ReactNode;
  readonly list: ReactNode;
  /** The page column, holding the route's own output. */
  readonly object: ReactNode;
  readonly chat: ReactNode;
  /** The empty middle, once every middle area is closed. */
  readonly empty: ReactNode;
  /** The ⌘K palette: drawn over every pane, so it sits outside them. */
  readonly palette: ReactNode;
  /** Below 1280px Imago floats; below 1024px the pane does too. Desktop when omitted. */
  readonly tier?: ViewportTier;
  /** Void action: the scrim behind the Imago sheet was pressed. */
  readonly onDismissImago?: () => void;
  /** Void action: the scrim behind the pane sheet was pressed. */
  readonly onDismissPane?: () => void;
  /** The left pane's dragged width in px, while it is docked. */
  readonly leftSize?: number;
  /** Imago's dragged width in px, while it is docked beside a page. */
  readonly imagoSize?: number;
  /** The seam on the left pane's right edge, while it is docked. */
  readonly leftHandle?: ReactNode;
  /** The seam on docked Imago's left edge. */
  readonly imagoHandle?: ReactNode;
  /** Under the Electron desktop app: the frame marks itself so the desktop CSS insets the spine. */
  readonly desktopFrame?: boolean;
};

/**
 * The spine beside the stage sheet; in the sheet, the tab bar over the columns: the left
 * pane, the page, Imago and the empty middle (SPEC v3.3). Every slot is always mounted and
 * only its width follows the state, so a navigation moves the columns rather than replacing
 * them (myimago ADR 0029 decision 2). A docked left pane and docked Imago each carry a seam
 * on their inner edge that drags their width, as classic's resizable panels do. The data attributes name the state for tests and
 * devtools; nothing styles off them.
 */
export function renderShell(props: ShellRenderProps): ReactNode {
  const { stage, layout, columns, hydrated, rail, banner, tabBar, list, object, chat, empty, palette } = props;
  const tier = props.tier ?? 'desktop';
  return (
    <div
      className={shellClass}
      data-section={stage.section}
      data-list={layout.list}
      data-list-hidden={layout.listHidden}
      data-object={stage.object?.kind}
      data-imago={columns.imago}
      data-tier={tier}
      data-hydrated={hydrated ? '' : undefined}
      data-desktop-frame={props.desktopFrame ? '' : undefined}
    >
      <nav aria-label="Sections" className={railClass} data-slot="rail" data-desktop-drag="">
        {rail}
      </nav>
      <div className={stageSheetClass} data-slot="stage">
        {banner}
        {tabBar}
        <div className={columnsRowClass}>
          {columns.paneSheet ? (
            <button type="button" className={scrimClass} aria-label="Dismiss sidebar" onClick={props.onDismissPane} />
          ) : null}
          {columns.imago === 'overlay' ? (
            <button type="button" className={scrimClass} aria-label="Dismiss Imago overlay" onClick={props.onDismissImago} />
          ) : null}
          <Pane open={layout.list !== 'closed'} width={listSlotClass(columns, layout.list, tier)} size={props.leftSize} slot="list">
            {list}
          </Pane>
          {props.leftHandle}
          <Pane open={columns.page} width={objectSlotClass(columns)} slot="object">
            {object}
          </Pane>
          {props.imagoHandle}
          <Pane
            open={columns.imago === 'docked' || columns.imago === 'overlay' || columns.imago === 'ground'}
            width={chatSlotClass(columns, tier)}
            size={props.imagoSize}
            slot="chat"
          >
            {chat}
          </Pane>
          <Pane open={columns.imago === 'none'} width={emptySlotClass(columns)} slot="empty">
            {empty}
          </Pane>
        </div>
      </div>
      {palette}
    </div>
  );
}
