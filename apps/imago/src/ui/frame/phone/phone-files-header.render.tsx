import Link from 'next/link';
import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import {
  phoneHeadClass,
  phoneHeadControlClass,
  phoneHeadCountClass,
  phoneHeadSpacerClass,
  phoneSwitchClass,
  phoneSwitchLabelClass,
  phoneSwitchSubClass,
  phoneSwitchTileClass,
  phoneSwitchTitleClass,
} from './phone-files-header-class';

export type PhoneFilesHeaderRenderProps = {
  /** The open drive's name; null until the API has listed it. */
  readonly driveName: string | null;
  readonly title: string;
  readonly unread: number;
  readonly notificationsHref: string;
  /** Void action: the drive tile was pressed. */
  readonly onSwitch: () => void;
  readonly open: boolean;
  /** Void action: opens the ⌘K palette. */
  readonly onSearch: () => void;
  /** The pane's New page button, from the Files pane. */
  readonly newPage: ReactNode;
  /** The drive switcher, mounted once the viewer has opened it. */
  readonly switcher?: ReactNode;
};

/**
 * The 52px head of the phone Files screen (C-Resp-Phone-Tree): the drive switcher (tile, title
 * over drive), then Search, Notifications and New page. The bell and search live here because the
 * spine that carries them elsewhere is gone.
 */
export function renderPhoneFilesHeader(props: PhoneFilesHeaderRenderProps): ReactNode {
  const { driveName, title, unread, notificationsHref, onSwitch, open, onSearch, newPage, switcher } = props;
  return (
    <header className={phoneHeadClass}>
      <button
        type="button"
        className={phoneSwitchClass}
        aria-label={driveName === null ? 'Switch drive' : `Switch drive: ${driveName}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={onSwitch}
      >
        <span className={phoneSwitchTileClass} aria-hidden="true">
          {driveName === null ? renderIcon({ name: 'grid', size: 16 }) : driveName.trim().slice(0, 1).toUpperCase()}
        </span>
        <span className={phoneSwitchLabelClass}>
          <span className={phoneSwitchTitleClass}>{title}</span>
          {driveName === null ? null : <span className={phoneSwitchSubClass}>{driveName}</span>}
        </span>
        {renderIcon({ name: 'chevronDown', size: 11 })}
      </button>
      {switcher}
      <span className={phoneHeadSpacerClass} />
      <button type="button" className={phoneHeadControlClass} aria-label="Search" onClick={onSearch}>
        {renderIcon({ name: 'search', size: 19 })}
      </button>
      <Link
        href={notificationsHref}
        prefetch={true}
        className={phoneHeadControlClass}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      >
        {renderIcon({ name: 'bell', size: 19 })}
        {unread > 0 ? (
          <span className={phoneHeadCountClass} aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </Link>
      {newPage}
    </header>
  );
}
