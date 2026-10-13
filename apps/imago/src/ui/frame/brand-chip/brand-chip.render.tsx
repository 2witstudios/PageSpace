import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import { renderRailTooltip } from '../rail-button/rail-button.render';
import type { DriveSummary } from '../drives/drives';
import { brandChipClass, brandSummaryClass } from './brand-chip-class';

export type BrandChipRenderProps = {
  /** The drive the URL names (or the Home drive on driveless stages); null with none. */
  readonly currentId: string | null;
  /** The viewer's drives as the API listed them; null until they arrive. */
  readonly drives: readonly DriveSummary[] | null;
  readonly organization?: { readonly name: string } | null;
  readonly open: boolean;
  /** Void action: the tile was pressed. */
  readonly onToggle: () => void;
  /** The switcher dialog, mounted beside the tile once the viewer has opened it. */
  readonly switcher?: ReactNode;
};

const initial = (name: string): string => name.trim().slice(0, 1).toUpperCase();

/**
 * The drive tile at the top of the spine: the open drive's initial, which
 * opens the switcher dialog (apps/web's DriveSwitcherDialog, re-skinned as an
 * anchored popover). A drive is named only once the API has listed it, so an
 * address naming a drive the viewer cannot reach shows no name at all.
 */
export function renderBrandChip(props: BrandChipRenderProps): ReactNode {
  const { drives, currentId, open, onToggle, switcher } = props;
  const current = props.organization ?? drives?.find((drive) => drive.id === currentId) ?? null;
  const label = current === null ? 'Switch drive' : props.organization ? `Switch workspace: ${current.name}` : `Switch drive: ${current.name}`;
  return (
    <div className="relative">
      <button type="button" className={brandSummaryClass} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={onToggle}>
        <span className={brandChipClass} aria-hidden="true">
          {current === null ? renderIcon({ name: 'grid' }) : initial(current.name)}
        </span>
        {renderRailTooltip(current?.name ?? 'Drives')}
      </button>
      {switcher}
    </div>
  );
}
