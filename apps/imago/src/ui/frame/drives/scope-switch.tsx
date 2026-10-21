'use client';

import type { ReactNode } from 'react';
import { ChoiceMenu } from '../../components/popover/menu';
import { renderIcon } from '../../components/icon/icon.render';
import type { ScopedSection, SectionScope } from './section-scope';
import { useDriveNames } from './use-drive-names';
import { useSectionScope } from './use-section-scope';

/** A quiet chip beside a pane's title: the scope it reads, with a chevron. */
const chipClass =
  'flex h-6 min-w-0 shrink items-center gap-1 rounded-md border-0 bg-transparent px-2 text-xs font-medium text-ink-muted hover:bg-fill hover:text-ink';

export type ScopeSwitchViewProps = {
  readonly driveName: string;
  readonly scope: SectionScope;
  /** Void action: called with the other scope. */
  readonly choose: (scope: SectionScope) => void;
};

/** The switch drawn from its props: the drive by name, or All drives. */
export function renderScopeSwitch({ driveName, scope, choose }: ScopeSwitchViewProps): ReactNode {
  return (
    <ChoiceMenu
      label="Show"
      value={scope}
      options={[
        { value: 'drive', label: driveName },
        { value: 'all', label: 'All drives' },
      ]}
      // The menu offers only these two values.
      choose={(next) => choose(next === 'all' ? 'all' : 'drive')}
      trigger={
        <button type="button" className={chipClass} aria-label={`Showing ${scope === 'all' ? 'all drives' : driveName}`}>
          <span className="min-w-0 truncate">{scope === 'all' ? 'All drives' : driveName}</span>
          {renderIcon({ name: 'chevronDown', size: 12 })}
        </button>
      }
    />
  );
}

/**
 * A section head's scope switch: the URL's drive, or every drive the viewer can reach. The choice
 * is the section's own and holds on every drive.
 */
export function ScopeSwitch({ section, driveId }: { readonly section: ScopedSection; readonly driveId: string }) {
  const [scope, setScope] = useSectionScope(section, driveId);
  const driveName = useDriveNames(true)?.get(driveId) ?? 'This drive';
  return renderScopeSwitch({ driveName, scope, choose: setScope });
}
