import type { ReactNode } from 'react';
import type { Stage } from '../stage/stage';
import { phoneMainBarlessClass, phoneMainClass, phoneShellClass } from './phone-shell-class';

export type PhoneShellRenderProps = {
  readonly stage: Stage;
  readonly hydrated: boolean;
  /** The one screen in view: the Files tree, a page, a list or Imago. */
  readonly screen: ReactNode;
  /** The floating Ask over the Files tree; null where the screen has its own. */
  readonly ask: ReactNode;
  /** The bottom bar. */
  readonly bar: ReactNode;
  readonly palette: ReactNode;
};

/**
 * The phone frame: one column and the bottom bar, no spine and no tab bar. The shell hands it
 * the screen the URL names; the other columns are not mounted.
 */
export function renderPhoneShell({ stage, hydrated, screen, ask, bar, palette }: PhoneShellRenderProps): ReactNode {
  return (
    <div
      className={phoneShellClass}
      data-tier="phone"
      data-section={stage.section}
      data-object={stage.object?.kind}
      data-hydrated={hydrated ? '' : undefined}
    >
      <main className={bar === null ? phoneMainBarlessClass : phoneMainClass}>{screen}</main>
      {ask}
      {bar}
      {palette}
    </div>
  );
}
