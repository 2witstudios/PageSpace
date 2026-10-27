import type { ReactNode } from 'react';
import { renderIcon } from '../../components/icon/icon.render';
import { renderRailTooltip } from '../rail-button/rail-button.render';
import { renderDriveMark } from '../../components/drive-mark/drive-mark.render';
import type { DriveSummary } from '../drives/drives';
import { brandChipClass, brandChipFillClass, brandChipShapeClass, brandSummaryClass } from './brand-chip-class';

export type BrandChipRenderProps = {
  /** The drive the URL names (or the Home drive on driveless stages); null with none. */
  readonly currentId: string | null;
  /** The viewer's drives as the API listed them; null until they arrive. */
  readonly drives: readonly DriveSummary[] | null;
  readonly organization?: { readonly name: string; readonly avatarUrl?: string | null } | null;
  /** The avatar of the org that owns the open drive, which stands in when the drive has no mark of its own. */
  readonly orgAvatarUrl?: string | null;
  readonly open: boolean;
  /** Void action: the tile was pressed. */
  readonly onToggle: () => void;
  /** The switcher dialog, mounted beside the tile once the viewer has opened it. */
  readonly switcher?: ReactNode;
};

/**
 * The drive tile at the top of the spine: the open drive's mark (its image,
 * or its initial on its color, else its org's image, else its initial), which
 * opens the switcher dialog (apps/web's DriveSwitcherDialog, re-skinned as an
 * anchored popover). A drive is named only once the API has listed it, so an
 * address naming a drive the viewer cannot reach shows no name at all.
 */
export function renderBrandChip(props: BrandChipRenderProps): ReactNode {
  const { drives, currentId, open, onToggle, switcher } = props;
  const drive = drives?.find((entry) => entry.id === currentId) ?? null;
  const current = props.organization ?? drive;
  const label = current === null ? 'Switch drive' : props.organization ? `Switch workspace: ${current.name}` : `Switch drive: ${current.name}`;
  // On an org's own pages the tile is the org's: its avatar over its initial.
  const mark = props.organization
    ? { name: props.organization.name, orgAvatarUrl: props.organization.avatarUrl }
    : drive && { ...drive, orgAvatarUrl: props.orgAvatarUrl };
  return (
    <div className="relative">
      <button type="button" className={brandSummaryClass} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={onToggle}>
        {mark ? (
          renderDriveMark({ drive: mark, shape: brandChipShapeClass, fill: brandChipFillClass })
        ) : (
          <span className={brandChipClass} aria-hidden="true">
            {renderIcon({ name: 'grid' })}
          </span>
        )}
        {renderRailTooltip(current?.name ?? 'Drives')}
      </button>
      {switcher}
    </div>
  );
}
