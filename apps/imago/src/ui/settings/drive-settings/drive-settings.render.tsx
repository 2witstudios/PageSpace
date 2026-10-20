import type { KeyboardEvent, ReactNode } from 'react';
import { homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { AVATAR_MIME_TYPES, MARK_COLORS, isMarkColor, type MarkColor } from '@pagespace/lib/avatars/avatar-core';
import { renderAvatar } from '../../components/avatar/avatar.render';
import { renderBadge } from '../../components/badge/badge.render';
import { renderButton } from '../../components/button/button.render';
import { buttonClass } from '../../components/button/button-class';
import { renderDriveMark } from '../../components/drive-mark/drive-mark.render';
import { markFillClass } from '../../components/drive-mark/drive-mark-class';
import { renderIcon } from '../../components/icon/icon.render';
import { renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import Link from 'next/link';
import { imagoHref } from '@/retained-adapters/navigation';
import type { DriveActions, DriveRole, DriveSettings, ImagoAccess, Member } from '../settings-model/settings-model';
import {
  appearanceControlsClass,
  appearancePreviewFillClass,
  appearancePreviewShapeClass,
  appearanceRowClass,
  memberEmailClass,
  memberNameClass,
  memberRowClass,
  memberTextClass,
  membersListClass,
  settingsClass,
  settingsDetailClass,
  settingsHeadingClass,
  settingsLinkClass,
  settingsNameClass,
  settingsNameInputClass,
  settingsNoticeClass,
  settingsRowClass,
  settingsSectionClass,
  settingsTitleClass,
  switchClass,
  switchKnobClass,
  swatchClass,
  swatchesClass,
} from './drive-settings-class';

/** Where a refusal is shown: under the control it came from. */
export type SettingsNotice = { readonly at: 'name' | 'imago' | 'appearance'; readonly message: string };

/** The drive's image and color: void actions, and a change on its way to the server. */
export type AppearanceActions = {
  readonly pending: boolean;
  readonly upload: (file: File) => void;
  readonly remove: () => void;
  readonly setColor: (color: MarkColor | null) => void;
};

export type DriveSettingsRenderProps = {
  readonly drive: DriveSettings;
  readonly actions: DriveActions;
  readonly members: readonly Member[] | undefined;
  readonly membersFailed: boolean;
  readonly retryMembers: () => void;
  readonly access: ImagoAccess | undefined;
  readonly accessFailed: boolean;
  readonly retryAccess: () => void;
  /** A toggle on its way to the server: the switch waits for the answer. */
  readonly accessPending: boolean;
  readonly notice: SettingsNotice | null;
  readonly rename: (name: string) => void;
  readonly toggleImagoAccess: (enabled: boolean) => void;
  readonly appearance: AppearanceActions;
  /** The owning org's avatar, which the drive's tile shows until it has a mark of its own. */
  readonly orgAvatarUrl?: string | null;
};

const AVATAR_ACCEPT = AVATAR_MIME_TYPES.filter((type) => type !== 'image/jpg').join(',');

const colorName = (color: MarkColor): string => color.charAt(0).toUpperCase() + color.slice(1);

const ROLE_LABELS: Readonly<Record<DriveRole, string>> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };

const noticeAt = (notice: SettingsNotice | null, at: SettingsNotice['at']): ReactNode =>
  notice?.at === at ? (
    <p role="alert" className={settingsNoticeClass}>
      {notice.message}
    </p>
  ) : null;

/* Text commits when it is left, not on every key: an edit is one change. A
   blank or unchanged name puts the old one back and sends nothing. */
const nameInput = (name: string, rename: (name: string) => void): ReactNode => (
  <input
    key={name}
    aria-label="Drive name"
    defaultValue={name}
    className={settingsNameInputClass}
    onBlur={(event) => {
      const value = event.currentTarget.value.trim();
      if (value === '' || value === name) {
        event.currentTarget.value = name;
        return;
      }
      rename(value);
    }}
    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') event.currentTarget.value = name;
      if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
    }}
  />
);

const driveSection = ({ drive, actions, notice, rename }: DriveSettingsRenderProps): ReactNode => (
  <section aria-labelledby="drive-heading" className={settingsSectionClass}>
    <h2 id="drive-heading" className={settingsHeadingClass}>
      Drive
    </h2>
    {actions.rename ? (
      nameInput(drive.name, rename)
    ) : (
      <p className={settingsNameClass} data-drive-name="">
        {drive.name}
      </p>
    )}
    {noticeAt(notice, 'name')}
    {drive.kind === 'HOME' ? <p className={settingsDetailClass}>{homeDriveActionError(drive, 'rename')}</p> : null}
  </section>
);

const swatch = (label: string, fill: string, selected: boolean, appearance: AppearanceActions, pick: () => void): ReactNode => (
  <li key={label}>
    <button
      type="button"
      aria-label={label}
      aria-pressed={selected}
      title={label}
      disabled={appearance.pending}
      className={`${swatchClass(selected)} ${fill}`}
      onClick={pick}
    >
      {selected ? renderIcon({ name: 'check', size: 14 }) : null}
    </button>
  </li>
);

/* The drive's tile as the spine draws it, an image to upload or remove, and
   the colors its initial may sit on. Shown to those who may change it. */
const appearanceSection = ({ drive, appearance, notice, orgAvatarUrl }: DriveSettingsRenderProps): ReactNode => {
  const color = isMarkColor(drive.color) ? drive.color : null;
  return (
    <section aria-labelledby="appearance-heading" className={settingsSectionClass}>
      <h2 id="appearance-heading" className={settingsHeadingClass}>
        Appearance
      </h2>
      <p className={settingsDetailClass}>How this drive appears at the top of the rail and in the drive switcher.</p>
      <div className={appearanceRowClass}>
        {renderDriveMark({
          drive: { ...drive, orgAvatarUrl },
          shape: appearancePreviewShapeClass,
          fill: appearancePreviewFillClass,
        })}
        <div className={appearanceControlsClass}>
          {/* The label is the button: pressing it, or the focused input inside it, opens the file picker. */}
          <label className={buttonClass('secondary')} data-disabled={appearance.pending ? '' : undefined}>
            {drive.avatarUrl ? 'Change image' : 'Upload image'}
            <input
              type="file"
              accept={AVATAR_ACCEPT}
              className="sr-only"
              aria-label={drive.avatarUrl ? 'Change drive image' : 'Upload drive image'}
              disabled={appearance.pending}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) appearance.upload(file);
              }}
            />
          </label>
          {drive.avatarUrl
            ? renderButton({ variant: 'ghost', disabled: appearance.pending, children: 'Remove image', onClick: appearance.remove })
            : null}
        </div>
      </div>
      <p className={settingsDetailClass}>JPEG, PNG, GIF or WebP, up to 5 MB. Without an image, the initial sits on its color.</p>
      <ul aria-label="Color" className={swatchesClass}>
        {swatch('Default', appearancePreviewFillClass, color === null, appearance, () => color === null || appearance.setColor(null))}
        {MARK_COLORS.map((option) =>
          swatch(colorName(option), markFillClass[option], color === option, appearance, () => color === option || appearance.setColor(option)),
        )}
      </ul>
      {noticeAt(notice, 'appearance')}
    </section>
  );
};

const imagoSwitch = (access: ImagoAccess, pending: boolean, toggle: (enabled: boolean) => void): ReactNode => (
  <button
    type="button"
    role="switch"
    aria-label="Imago access"
    aria-checked={access.enabled}
    disabled={pending}
    className={switchClass(access.enabled)}
    onClick={() => toggle(!access.enabled)}
  >
    <span aria-hidden="true" className={switchKnobClass(access.enabled)} />
  </button>
);

const imagoControl = (props: DriveSettingsRenderProps): ReactNode => {
  const { drive, access, accessFailed, retryAccess, accessPending, toggleImagoAccess } = props;
  // The Home drive guard's own words: Imago lives there. `actions.imagoAccess`
  // is this same guard's verdict, so the reason is the one thing to ask.
  const homeReason = homeDriveActionError(drive, 'imago-access');
  if (homeReason !== null) return <p className={settingsDetailClass}>{homeReason}</p>;
  if (access === undefined) {
    return accessFailed
      ? renderErrorState({ title: 'Could not load Imago access', retry: retryAccess })
      : renderLoadingState('Loading Imago access…');
  }
  return (
    <div className={settingsRowClass}>
      <p className={settingsDetailClass}>
        Let Imago work in this drive with your access. Turn it off to keep Imago out of it — its pages, search results
        and integrations — for you only.
      </p>
      {imagoSwitch(access, accessPending, toggleImagoAccess)}
    </div>
  );
};

const imagoSection = (props: DriveSettingsRenderProps): ReactNode => (
  <section aria-labelledby="imago-heading" className={settingsSectionClass}>
    <h2 id="imago-heading" className={settingsHeadingClass}>
      Imago access
    </h2>
    {imagoControl(props)}
    {noticeAt(props.notice, 'imago')}
  </section>
);

const memberRow = (member: Member): ReactNode => (
  <li key={member.userId} className={memberRowClass}>
    {renderAvatar({ name: member.name, size: 'sm' })}
    <span className={memberTextClass}>
      <span className={memberNameClass} data-member-name="">
        {member.name}
      </span>
      {member.email === null || member.email === member.name ? null : (
        <span className={memberEmailClass} data-member-email="">
          {member.email}
        </span>
      )}
    </span>
    <span data-member-role="">{renderBadge({ children: member.customRole ?? ROLE_LABELS[member.role] })}</span>
  </li>
);

const membersSection = ({ drive, members, membersFailed, retryMembers }: DriveSettingsRenderProps): ReactNode => (
  <section aria-labelledby="members-heading" className={settingsSectionClass}>
    <h2 id="members-heading" className={settingsHeadingClass}>
      Members
    </h2>
    {members === undefined ? (
      membersFailed ? (
        renderErrorState({ title: 'Could not load members', retry: retryMembers })
      ) : (
        renderLoadingState('Loading members…')
      )
    ) : (
      <ul aria-label="Members" className={membersListClass}>
        {members.map(memberRow)}
      </ul>
    )}
    {drive.kind === 'HOME' ? null : (
      <Link href={imagoHref(`/dashboard/${drive.id}/members`)} className={settingsLinkClass}>
        Manage members
      </Link>
    )}
  </section>
);

/** A drive's settings as the object beside the chat: name, Imago access and members. */
export function renderDriveSettings(props: DriveSettingsRenderProps): ReactNode {
  return (
    <div className={settingsClass} data-drive-settings="">
      <h1 className={settingsTitleClass}>Settings</h1>
      {driveSection(props)}
      {props.actions.appearance ? appearanceSection(props) : null}
      {imagoSection(props)}
      {membersSection(props)}
    </div>
  );
}
