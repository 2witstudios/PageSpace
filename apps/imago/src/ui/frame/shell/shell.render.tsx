import type { ReactNode } from 'react';
import type { PaneLayout, Stage } from '../stage/stage';
import { Pane } from '../pane/pane';
import { chatSlotClass, listSlotClass, objectSlotClass, railClass, shellClass } from './shell-class';

export type ShellRenderProps = {
  readonly stage: Stage;
  readonly layout: PaneLayout;
  /** React has hydrated the shell, so its controls act. */
  readonly hydrated: boolean;
  readonly rail: ReactNode;
  readonly list: ReactNode;
  /** The object column, holding the route's own output. */
  readonly object: ReactNode;
  readonly chat: ReactNode;
  /** The ⌘K palette: drawn over every pane, so it sits outside them. */
  readonly palette: ReactNode;
};

/**
 * The app fills the viewport: rail, list, object, chat. Every pane is always
 * mounted and only its width follows the stage, so a navigation moves the
 * panes rather than replacing them (myimago ADR 0029 decision 2). The data
 * attributes name the stage for tests and devtools; nothing styles off them.
 */
export function renderShell(props: ShellRenderProps): ReactNode {
  const { stage, layout, hydrated, rail, list, object, chat, palette } = props;
  return (
    <div
      className={shellClass}
      data-section={stage.section}
      data-list={layout.list}
      data-list-hidden={layout.listHidden}
      data-object={stage.object?.kind}
      data-hydrated={hydrated ? '' : undefined}
    >
      <nav aria-label="Primary" className={railClass} data-slot="rail">
        {rail}
      </nav>
      <Pane open={layout.list !== 'closed'} width={listSlotClass(layout)} slot="list">
        {list}
      </Pane>
      <Pane open={layout.object} width={objectSlotClass(layout)} slot="object">
        {object}
      </Pane>
      <Pane open width={chatSlotClass(layout)} slot="chat">
        {chat}
      </Pane>
      {palette}
    </div>
  );
}
