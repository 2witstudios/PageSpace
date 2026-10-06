import type { KeyboardEvent, ReactNode } from 'react';
import { homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { renderAvatar } from '../../components/avatar/avatar.render';
import { renderBadge } from '../../components/badge/badge.render';
import { renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { classicHref } from '../../frame/rail/rail-items';
import type { DriveActions, DriveRole, DriveSettings, ImagoAccess, Member } from '../settings-model/settings-model';
import {
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
} from './drive-settings-class';

/** Where a refusal is shown: under the control it came from. */
export type SettingsNotice = { readonly at: 'name' | 'imago'; readonly message: string };

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
};

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
      <a href={classicHref(drive.id, 'members')} className={settingsLinkClass}>
        Manage members in Classic PageSpace
      </a>
    )}
  </section>
);

/** A drive's settings as the object beside the chat: name, Imago access and members. */
export function renderDriveSettings(props: DriveSettingsRenderProps): ReactNode {
  return (
    <div className={settingsClass} data-drive-settings="">
      <h1 className={settingsTitleClass}>Settings</h1>
      {driveSection(props)}
      {imagoSection(props)}
      {membersSection(props)}
    </div>
  );
}
