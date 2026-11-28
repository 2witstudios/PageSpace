'use client';

// The viewer's Imago access switch (IMG-10.10). No board draws it, so it stays on General as a
// section of its own: the e2e 28-imago-settings spec still asserts it, and it is a real control.
// The write goes through the shared drive settings hook, so a refusal rolls the switch back and says why.

import { useState, type ReactNode } from 'react';
import { homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { switchClass, switchKnobClass, settingsNoticeClass } from '../drive-settings/drive-settings-class';
import { SettingsGroup, SettingsRow, SettingsSection } from '../settings-screen/settings-screen';
import { useDriveSettings } from '../use-drive-settings/use-drive-settings';

export function ImagoAccessSection({ driveId }: { readonly driveId: string }): ReactNode {
  const settings = useDriveSettings(driveId);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { drive, actions, access } = settings;

  if (drive === undefined || actions === null) return null;

  const homeReason = homeDriveActionError(drive, 'imago-access');
  const body = (): ReactNode => {
    if (homeReason !== null) return <p className="m-0 text-sm text-ink-muted">{homeReason}</p>;
    if (access === undefined) {
      return settings.accessError === undefined
        ? renderLoadingState('Loading Imago access…')
        : renderErrorState({ title: 'Could not load Imago access', retry: settings.retryAccess });
    }
    return (
      <SettingsGroup>
        <SettingsRow label="Imago works in this drive">
          <button
            type="button"
            role="switch"
            aria-label="Imago access"
            aria-checked={access.enabled}
            disabled={pending}
            className={switchClass(access.enabled)}
            onClick={() => {
              setPending(true);
              void settings
                .setImagoAccess(!access.enabled)
                .then((result) => setRefusal(result.ok ? null : result.refusal))
                .finally(() => setPending(false));
            }}
          >
            <span aria-hidden="true" className={switchKnobClass(access.enabled)} />
          </button>
        </SettingsRow>
      </SettingsGroup>
    );
  };

  return (
    <SettingsSection
      title="Imago access"
      description="Let Imago work in this drive with your access. Turn it off to keep Imago out of it — its pages, search results and integrations — for you only."
    >
      {body()}
      {refusal === null ? null : (
        <p role="alert" className={settingsNoticeClass}>
          {refusal}
        </p>
      )}
    </SettingsSection>
  );
}
