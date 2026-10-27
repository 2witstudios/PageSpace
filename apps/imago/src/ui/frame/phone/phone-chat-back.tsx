'use client';

import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import { usePage } from '../../files/page-object/page-object';
import { pageTabOf } from '../tabs/tab-label';
import { phoneHeadControlClass } from './phone-files-header-class';

export type PhoneChatBackProps = {
  readonly pageId: string;
  /** Void action: Back was pressed, and the page returns with the bottom bar. */
  readonly onBack: () => void;
};

/** "Back to {page}" in the full-screen Imago head (C-Resp-Phone-Chat). */
export function PhoneChatBack({ pageId, onBack }: PhoneChatBackProps): ReactNode {
  const { data } = usePage(pageId);
  const title = pageTabOf(data)?.title;
  return (
    <button type="button" className={phoneHeadControlClass} aria-label={title === undefined ? 'Back to page' : `Back to ${title}`} onClick={onBack}>
      {renderIcon({ name: 'chevronLeft', size: 20 })}
    </button>
  );
}
