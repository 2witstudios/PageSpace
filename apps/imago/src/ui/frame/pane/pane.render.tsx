import type { ReactNode, TransitionEvent } from 'react';
import { paneClass } from './pane-class';

export type PaneRenderProps = {
  readonly open: boolean;
  /** This stage's width token; the pane animates between them. */
  readonly width: string;
  /** Names the shell slot for tests and devtools; nothing styles off it. */
  readonly slot?: string;
  /** What the pane shows: its children while open, the kept ones while closing. */
  readonly content: ReactNode;
  readonly onTransitionEnd: (event: TransitionEvent<HTMLDivElement>) => void;
};

/**
 * A closed pane is out of reach: `inert` takes it out of focus and pointer
 * order, and `aria-hidden` out of the accessibility tree, while its last
 * content slides out with it.
 */
export function renderPane(props: PaneRenderProps): ReactNode {
  const { open, width, slot, content, onTransitionEnd } = props;
  return (
    <div
      className={paneClass(width)}
      data-slot={slot}
      inert={!open}
      aria-hidden={open ? undefined : true}
      onTransitionEnd={onTransitionEnd}
    >
      {content}
    </div>
  );
}
