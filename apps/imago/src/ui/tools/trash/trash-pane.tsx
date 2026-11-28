'use client';

import type { ReactNode } from 'react';
import { useSearchParams } from 'next/navigation';
import { renderToolPane, renderToolScreenRow, type ToolPaneProps } from '../../frame/tool-pane/tool-pane.render';
import { useToolScreen } from '../../frame/tool-pane/tool-screen';
import { trashFilterFrom, type TrashFilter } from './trash-model';
import { trashFilterHref } from './trash-view';

const rows: readonly { readonly filter: TrashFilter; readonly label: string }[] = [
  { filter: 'all', label: 'Everything in trash' },
  { filter: 'pages', label: 'Pages' },
  { filter: 'files', label: 'Files' },
];

/** The Trash tool's pane: what to show of the drive's trash. A row opens the trash screen filtered to it. */
export function TrashPane({ driveId, close, variant }: ToolPaneProps): ReactNode {
  const screen = useToolScreen(driveId, 'trash');
  const current = trashFilterFrom(useSearchParams().get('type'));
  return renderToolPane({
    title: 'Trash',
    close,
    variant,
    children: (
      <nav aria-label="Trash" className="flex flex-col gap-px">
        {rows.map((row) => (
          <div key={row.filter} className="contents">
            {renderToolScreenRow({
              href: trashFilterHref(driveId, row.filter),
              label: row.label,
              selected: screen.onScreen && current === row.filter,
            })}
          </div>
        ))}
      </nav>
    ),
  });
}
