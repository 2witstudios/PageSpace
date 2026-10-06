'use client';

import { useState, type ReactNode } from 'react';
import { edgeOf, renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { DRIVE_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
import { useDriveSettings, type WriteResult } from '../use-drive-settings/use-drive-settings';
import { renderDriveSettings, type SettingsNotice } from './drive-settings.render';

export type DriveSettingsObjectProps = { readonly driveId: string };

/**
 * What /imago/[driveId]/settings opens in the object slot. Which controls it
 * draws follows the viewer's role and the Home drive guards; whether a change
 * holds is always the server's answer.
 */
export function DriveSettingsObject({ driveId }: DriveSettingsObjectProps): ReactNode {
  const settings = useDriveSettings(driveId);
  const [notice, setNotice] = useState<SettingsNotice | null>(null);
  const [accessPending, setAccessPending] = useState(false);
  const { drive, actions } = settings;

  if (drive === undefined || actions === null) {
    if (settings.driveError === undefined) return renderLoadingState('Loading settings…');
    return edgeOf(settings.driveError) === 'not-found'
      ? renderNotFound({ ...DRIVE_NOT_FOUND, homeHref: null })
      : renderErrorState({ title: 'Could not load drive settings', retry: settings.retryDrive });
  }

  const report = (at: SettingsNotice['at']) => (result: WriteResult) =>
    setNotice(result.ok ? null : { at, message: result.refusal });

  return renderDriveSettings({
    drive,
    actions,
    members: settings.members,
    membersFailed: settings.membersError !== undefined,
    retryMembers: settings.retryMembers,
    access: settings.access,
    accessFailed: settings.accessError !== undefined,
    retryAccess: settings.retryAccess,
    accessPending,
    notice,
    rename: (name) => void settings.rename(name).then(report('name')),
    toggleImagoAccess: (enabled) => {
      setAccessPending(true);
      void settings
        .setImagoAccess(enabled)
        .then(report('imago'))
        .finally(() => setAccessPending(false));
    },
  });
}
