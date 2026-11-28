'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import useSWR from 'swr';
import { renderDriveMark } from '../../components/drive-mark/drive-mark.render';
import { cn } from '../../cn';
import { DRIVES, drivesFrom, type DriveSummary } from './drives';
import { useHomeDriveId } from './home-drive-context';
import type { ScopedSection } from './section-scope';
import { setSectionScope } from './use-section-scope';

const rowClass = (current: boolean): string =>
  cn(
    'flex h-pane-row items-center gap-2 rounded-md px-2 text-sm no-underline hover:no-underline',
    current ? 'bg-accent-soft font-medium text-accent-deep' : 'text-ink hover:bg-fill',
  );

const markShapeClass = 'flex size-5 flex-none items-center justify-center rounded-md text-2xs font-bold';
const markFillClass = 'bg-fill text-ink-muted';

export type DriveListRenderProps = {
  readonly drives: readonly DriveSummary[];
  readonly section: ScopedSection;
  /** The URL's drive, marked current. */
  readonly currentId: string;
  /** Void action: a drive was picked, so the section reads that drive. */
  readonly pick: () => void;
};

/** The drives as rows, each opening the section in that drive. */
export function renderDriveList({ drives, section, currentId, pick }: DriveListRenderProps): ReactNode {
  return drives.map((drive) => (
    <Link
      key={drive.id}
      href={`/${encodeURIComponent(drive.id)}/${section}`}
      prefetch={true}
      className={rowClass(drive.id === currentId)}
      aria-current={drive.id === currentId ? 'true' : undefined}
      onClick={pick}
    >
      {renderDriveMark({ drive, shape: markShapeClass, fill: markFillClass })}
      <span className="min-w-0 flex-1 truncate">{drive.name}</span>
    </Link>
  ));
}

/**
 * A section's All drives list where the section is a tree: rather than every drive's tree at
 * once, the drives to pick from. Picking one opens the section in that drive, scoped to it.
 */
export function DriveList({ section, currentId, filter = '' }: {
  readonly section: ScopedSection;
  readonly currentId: string;
  /** Narrows the drives by name. */
  readonly filter?: string;
}) {
  const { data } = useSWR<unknown>(DRIVES);
  const homeDriveId = useHomeDriveId();
  const needle = filter.trim().toLowerCase();
  const drives = (drivesFrom(data, homeDriveId) ?? []).filter(
    (drive) => needle === '' || drive.name.toLowerCase().includes(needle),
  );
  return renderDriveList({ drives, section, currentId, pick: () => setSectionScope(section, 'drive') });
}
