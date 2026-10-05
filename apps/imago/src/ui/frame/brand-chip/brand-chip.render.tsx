import Link from 'next/link';
import type { ReactNode, Ref, SyntheticEvent } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import { railHitClass } from '../rail-button/rail-button-class';
import { renderRailTooltip } from '../rail-button/rail-button.render';
import type { DriveSummary } from '../drives/drives';
import { brandChipClass, driveInitialClass, driveLinkClass, driveMenuClass, driveNoteClass } from './brand-chip-class';

export type BrandChipRenderProps = {
  /** The drive the URL names (or the Home drive on driveless stages); null with none. */
  readonly currentId: string | null;
  /** The viewer's drives as the API listed them; null until they arrive. */
  readonly drives: readonly DriveSummary[] | null;
  readonly failed: boolean;
  /** Where picking a drive goes: its copy of the current section. */
  readonly hrefFor: (driveId: string) => string;
  readonly open: boolean;
  readonly onToggle: (open: boolean) => void;
  /** Void action: a drive was picked, so the menu closes. */
  readonly onPick: () => void;
  readonly detailsRef?: Ref<HTMLDetailsElement> | undefined;
};

const initial = (name: string): string => name.trim().slice(0, 1).toUpperCase();

const note = (text: string): ReactNode => (
  <li className={driveNoteClass} role="status">
    {text}
  </li>
);

const rows = (props: BrandChipRenderProps): ReactNode => {
  const { drives, failed, currentId, hrefFor, onPick } = props;
  if (drives === null) return note(failed ? 'Couldn’t load drives' : 'Loading drives…');
  if (drives.length === 0) return note('No drives');
  return drives.map((drive) => {
    const current = drive.id === currentId;
    return (
      <li key={drive.id}>
        <Link
          href={hrefFor(drive.id)}
          prefetch={true}
          className={driveLinkClass(current)}
          aria-current={current ? 'page' : undefined}
          onClick={onPick}
        >
          <span className={driveInitialClass} aria-hidden="true">
            {initial(drive.name)}
          </span>
          {drive.name}
        </Link>
      </li>
    );
  });
};

/**
 * The drive switcher at the top of the rail: the open drive's initial on the
 * brand chip, and a native disclosure listing the viewer's drives. A drive
 * is named only once the API has listed it, so an address naming a drive the
 * viewer cannot reach shows no name at all.
 */
export function renderBrandChip(props: BrandChipRenderProps): ReactNode {
  const { drives, currentId, open, onToggle, detailsRef } = props;
  const current = drives?.find((drive) => drive.id === currentId) ?? null;
  const label = current === null ? 'Switch drive' : `Switch drive, ${current.name}`;
  return (
    <details
      ref={detailsRef}
      className="relative"
      open={open}
      onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => onToggle(event.currentTarget.open)}
    >
      <summary className={`${railHitClass(true)} summary-plain`} aria-label={label}>
        <span className={brandChipClass} aria-hidden="true">
          {current === null ? renderIcon({ name: 'grid' }) : initial(current.name)}
        </span>
        {renderRailTooltip(current?.name ?? 'Drives')}
      </summary>
      <ul className={driveMenuClass} aria-label="Drives">
        {rows(props)}
      </ul>
    </details>
  );
}
