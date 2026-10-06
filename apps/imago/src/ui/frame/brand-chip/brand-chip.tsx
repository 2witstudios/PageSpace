'use client';

import type { DriveSummary } from '../drives/drives';
import { switchDriveHref } from '../drives/drives';
import { useDisclosure } from '../disclosure/use-disclosure';
import type { Stage } from '../stage/stage';
import { renderBrandChip } from './brand-chip.render';

export type BrandChipProps = {
  readonly stage: Stage;
  /** The drive the rail links into: the URL's, or Home on the driveless stages. */
  readonly currentId: string | null;
  readonly drives: readonly DriveSummary[] | null;
  readonly failed: boolean;
};

/** Binds the drive switcher to the stage: a picked drive opens on the same section. */
export function BrandChip({ stage, currentId, drives, failed }: BrandChipProps) {
  const { open, setOpen, ref } = useDisclosure();
  return renderBrandChip({
    currentId,
    drives,
    failed,
    hrefFor: (driveId) => switchDriveHref(stage, driveId),
    open,
    onToggle: setOpen,
    onPick: () => setOpen(false),
    detailsRef: ref,
  });
}
