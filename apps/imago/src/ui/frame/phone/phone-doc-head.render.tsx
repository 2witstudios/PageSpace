import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import {
  phoneCountChipClass,
  phoneCrumbClass,
  phoneParentClass,
  phonePresenceClass,
  phoneTitleClass,
} from './phone-doc-class';
import { phoneHeadClass, phoneHeadControlClass } from './phone-files-header-class';

export type PhoneDocHeadRenderProps = {
  /** The Files screen Back returns to. */
  readonly backHref: string;
  /** The folder the page sits in; none for a top-level page. */
  readonly parent: string | null;
  readonly title: string;
  /** Who is on the page (collaborative pages only). */
  readonly presence: ReactNode;
  /** How many pages are open. */
  readonly count: number;
  /** Void action: the count button was pressed. */
  readonly onOpenPages: () => void;
  /** The "Page actions" control; null until the page and its drive are known. */
  readonly actions: ReactNode;
};

/**
 * The 52px head of a page on a phone (C-Resp-Phone-Doc): Back to Pages, the parent folder over
 * the title, presence, the open-pages count and Page actions. Back replaces Close page, and the
 * tab strip collapses to the count.
 */
export function renderPhoneDocHead(props: PhoneDocHeadRenderProps): ReactNode {
  const { backHref, parent, title, presence, count, onOpenPages, actions } = props;
  return (
    <header className={phoneHeadClass}>
      <Link href={backHref} prefetch={true} className={phoneHeadControlClass} aria-label="Back to Pages">
        {renderIcon({ name: 'chevronLeft', size: 20 })}
      </Link>
      <div className={phoneCrumbClass}>
        {parent === null ? null : <span className={phoneParentClass}>{parent}</span>}
        <span className={phoneTitleClass}>{title}</span>
      </div>
      {presence === null ? null : <span className={phonePresenceClass}>{presence}</span>}
      <button type="button" className={phoneHeadControlClass} aria-label={`${count} open pages`} onClick={onOpenPages}>
        <span className={phoneCountChipClass}>{count}</span>
      </button>
      {actions}
    </header>
  );
}
