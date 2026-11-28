import type { ReactNode } from 'react';
import type { Presence } from '../../types/presence/presence';
import { presenceDotClass } from './presence-dot-class';

export type PresenceDotProps = {
  readonly presence: Presence;
};

const labels: Readonly<Record<Presence, string>> = {
  online: 'Online',
  away: 'Away',
  offline: 'Offline',
};

/* A named image, not a live region: a list of rows would otherwise
   announce every presence change at once. */
export function renderPresenceDot({ presence }: PresenceDotProps): ReactNode {
  return (
    <span
      className={presenceDotClass(presence)}
      role="img"
      aria-label={labels[presence]}
    />
  );
}
