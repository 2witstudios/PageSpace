import type { ReactNode } from 'react';
import type { Columns } from '../stage/columns';
import type { PaneLayout, Stage } from '../stage/stage';
import { Pane } from '../pane/pane';
import {
  chatSlotClass,
  columnsRowClass,
  emptySlotClass,
  listSlotClass,
  objectSlotClass,
  railClass,
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
};

/**
 * The spine beside the stage sheet; in the sheet, the tab bar over the columns: the left
 * pane, the page, Imago and the empty middle (SPEC v3.3). Every slot is always mounted and
 * only its width follows the state, so a navigation moves the columns rather than replacing
 * them (myimago ADR 0029 decision 2). The data attributes name the state for tests and
 * devtools; nothing styles off them.
 */
export function renderShell(props: ShellRenderProps): ReactNode {
  const { stage, layout, columns, hydrated, rail, banner, tabBar, list, object, chat, empty, palette } = props;
  return (
    <div
      className={shellClass}
      data-section={stage.section}
      data-list={layout.list}
      data-list-hidden={layout.listHidden}
      data-object={stage.object?.kind}
      data-imago={columns.imago}
      data-hydrated={hydrated ? '' : undefined}
    >
      <nav aria-label="Sections" className={railClass} data-slot="rail">
        {rail}
      </nav>
      <div className={stageSheetClass} data-slot="stage">
        {banner}
        {tabBar}
        <div className={columnsRowClass}>
          <Pane open={layout.list !== 'closed'} width={listSlotClass(columns, layout.list)} slot="list">
            {list}
          </Pane>
          <Pane open={columns.page} width={objectSlotClass(columns)} slot="object">
            {object}
          </Pane>
          <Pane open={columns.imago === 'docked' || columns.imago === 'ground'} width={chatSlotClass(columns)} slot="chat">
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
