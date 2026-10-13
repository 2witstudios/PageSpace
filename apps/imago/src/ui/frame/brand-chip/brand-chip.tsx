'use client';

import { useState } from 'react';
import DriveSwitcherDialog from '@/retained/components/layout/navbar/DriveSwitcherDialog';
import type { DriveSummary } from '../drives/drives';
import { renderBrandChip } from './brand-chip.render';

export type BrandChipProps = {
  /** The drive the rail links into: the URL's, or Home on the driveless stages. */
  readonly currentId: string | null;
  readonly drives: readonly DriveSummary[] | null;
};

/**
 * The spine's drive tile. It opens apps/web's DriveSwitcherDialog (search,
 * Favorites, Recent, All drives, Create drive, per-row star) from the retained
 * tree, which the app-wide RetainedProvider already surrounds; picking a drive
 * navigates through the retained navigation adapter to the imago drive route.
 * The dialog mounts on the first opening, so a shell that never opens it pays
 * for none of its stores.
 */
export function BrandChip({ currentId, drives }: BrandChipProps) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return renderBrandChip({
    currentId,
    drives,
    open,
    onToggle: () => {
      setOpened(true);
      setOpen((was) => !was);
    },
    switcher: opened ? <DriveSwitcherDialog open={open} onOpenChange={setOpen} /> : null,
  });
}
