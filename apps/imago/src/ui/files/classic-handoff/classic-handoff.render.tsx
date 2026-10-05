import type { ReactNode } from 'react';
import { cn } from '../../cn';
import { renderButton } from '../../components/button/button.render';
import { buttonClass } from '../../components/button/button-class';
import { renderIcon } from '../../components/icon/icon.render';
import type { Handoff } from './handoff';
import {
  handoffActionsClass,
  handoffCardClass,
  handoffClass,
  handoffDetailClass,
  handoffGlyphClass,
  handoffLinkClass,
  handoffTitleClass,
  handoffTypeClass,
} from './classic-handoff-class';

export type HandoffRenderProps = Omit<Handoff, 'agent'> & {
  /** Void action: chat with the page's agent; null for a page that is no agent. */
  readonly chat: (() => void) | null;
};

/**
 * The object card for a page imago does not draw: what it is, and the ways
 * on. Open in classic is a plain anchor, not next/link, so it is a full
 * navigation out of /imago (basePath never prefixes it).
 */
export function renderHandoff({ typeLabel, icon, title, classicHref, chat }: HandoffRenderProps): ReactNode {
  return (
    <div className={handoffClass} data-handoff="">
      <div className={handoffCardClass}>
        <span className={handoffGlyphClass}>{renderIcon({ name: icon, size: 20 })}</span>
        <p className={handoffTypeClass} data-handoff-type="">
          {typeLabel}
        </p>
        <h2 className={handoffTitleClass}>{title}</h2>
        <p className={handoffDetailClass}>
          {chat === null ? 'Imago does not open this kind of page yet.' : 'Talk to this agent here, or open it in classic.'}
        </p>
        <div className={handoffActionsClass}>
          {chat === null ? null : renderButton({ onClick: chat, children: 'Chat with this agent' })}
          <a href={classicHref} className={cn(buttonClass(chat === null ? 'primary' : 'secondary'), handoffLinkClass)}>
            Open in classic
          </a>
        </div>
      </div>
    </div>
  );
}
