import type { ReactNode } from 'react';
import { isMarkColor } from '@pagespace/lib/avatars/avatar-core';
import { driveMarkClass, driveMarkImageClass, markFillClass } from './drive-mark-class';

export type DriveMarkDrive = {
  readonly name: string;
  /** The drive's own image (its PageSpace avatar route), null without one. */
  readonly avatarUrl?: string | null;
  /** The palette key its initial sits on; anything else is the surface's own fill. */
  readonly color?: string | null;
  /** The owning org's avatar, which stands in when the drive has no mark of its own. */
  readonly orgAvatarUrl?: string | null;
};

export type DriveMarkProps = {
  readonly drive: DriveMarkDrive;
  /** The surface's tile: its size, radius and type, with no fill. */
  readonly shape: string;
  /** The surface's fill for a drive that chose no color. */
  readonly fill: string;
};

/** The first user-perceived character of the name, upper-cased (a whole emoji, never half of one). */
export const driveInitial = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed === '') return '?';
  const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)[Symbol.iterator]().next().value?.segment;
  return (first ?? '?').toUpperCase();
};

/**
 * A drive's tile: what the drive chose for itself first (its image, else its
 * initial on its color), then its org's image, then its initial on the
 * surface's own fill. An image that does not load hides itself, leaving the
 * initial beneath it. Decorative: the control around it carries the name.
 */
export function renderDriveMark({ drive, shape, fill }: DriveMarkProps): ReactNode {
  const color = isMarkColor(drive.color) ? drive.color : null;
  const src = drive.avatarUrl || (color === null ? drive.orgAvatarUrl : null) || null;
  const tile = color === null ? fill : markFillClass[color];
  return (
    <span className={`${shape} ${tile} ${driveMarkClass}`} aria-hidden="true" data-drive-mark="">
      {driveInitial(drive.name)}
      {src === null ? null : (
        // eslint-disable-next-line @next/next/no-img-element -- a PageSpace avatar route, drawn at the tile's own token size.
        <img
          src={src}
          alt=""
          className={`${driveMarkImageClass} ${tile}`}
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      )}
    </span>
  );
}
