'use client';

import type { ComponentType } from 'react';
import { ArrowLeft, BotMessageSquare, File, FileCode, FileImage, FileSpreadsheet, FileText, Folder, MessagesSquare, SquareCheckBig, X } from 'lucide-react';
import { format } from 'date-fns';
import Link from '@/retained-adapters/link';
import { Badge } from '@/retained/components/ui/badge';
import { Button } from '@/retained/components/ui/button';
import type { SnapshotPageNode } from '@/retained-adapters/ui-contracts';
import { sourceLabel, type SerializedBackup } from '../../utils';
import { getNodeIcon, type FlatSnapshotNode } from './utils';

const ICON_COMPONENTS: Record<string, ComponentType<{ className?: string }>> = {
  FileText,
  FileCode,
  FileSpreadsheet,
  FileImage,
  File,
  Folder,
  MessagesSquare,
  BotMessageSquare,
  SquareCheckBig,
};

export type SnapshotMeta = Pick<SerializedBackup, 'label' | 'source' | 'status' | 'createdAt'>;

export type SnapshotPaneProps = {
  readonly backup: SnapshotMeta;
  readonly nodes: readonly FlatSnapshotNode[];
  readonly selectedPageId: string | null;
  readonly onSelect: (node: SnapshotPageNode & { depth: number }) => void;
  readonly onClose: () => void;
};

/** The "Snapshot" pane: the All backups link, the header pills and the "Pages in snapshot" tree. */
export function SnapshotPane({ backup, nodes, selectedPageId, onSelect, onClose }: SnapshotPaneProps) {
  return (
    <aside aria-label="Snapshot pages" className="flex h-full w-[260px] flex-none flex-col border-r border-border bg-muted/40">
      <div className="flex h-12 flex-none items-center gap-1.5 border-b border-border pl-4 pr-2">
        <span className="flex-1 text-sm font-semibold">Snapshot</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close sidebar" title="Close sidebar" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-2.5">
        <Link href="/settings/backups" className="inline-flex h-7 items-center gap-1.5 self-start rounded-md px-2 text-sm text-muted-foreground hover:bg-muted">
          <ArrowLeft className="h-3.5 w-3.5" />
          All backups
        </Link>
        <div className="flex flex-col gap-1.5 px-2 pb-2">
          <span className="text-lg font-semibold tracking-tight">{backup.label ?? sourceLabel(backup.source)}</span>
          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant={backup.status === 'ready' ? 'default' : 'secondary'}>{backup.status}</Badge>
            <Badge variant="outline">{sourceLabel(backup.source)}</Badge>
            <span>{format(new Date(backup.createdAt), 'MMM d, h:mm a')}</span>
          </span>
        </div>
        <div role="tree" aria-label="Pages in snapshot" className="flex flex-col gap-px">
          {nodes.length === 0 ? (
            <p className="px-2 py-2 text-sm text-muted-foreground">No pages in this snapshot.</p>
          ) : (
            nodes.map((node) => {
              const Icon = ICON_COMPONENTS[getNodeIcon(node.type)] ?? File;
              const selected = node.pageId === selectedPageId;
              return (
                <button
                  key={node.pageId}
                  type="button"
                  role="treeitem"
                  aria-level={node.depth + 1}
                  aria-selected={selected}
                  onClick={() => onSelect(node)}
                  style={{ paddingLeft: `${8 + node.depth * 16}px` }}
                  className={`flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-sm hover:bg-muted ${selected ? 'bg-background font-medium shadow-sm' : ''}`}
                >
                  <Icon className="h-3.5 w-3.5 flex-none text-muted-foreground" />
                  <span className={`min-w-0 flex-1 truncate ${node.isTrashed ? 'text-muted-foreground line-through' : ''}`}>
                    {node.title ?? 'Untitled'}
                  </span>
                  {node.isTrashed && (
                    <span className="inline-flex h-[18px] flex-none items-center rounded-full border px-1.5 text-[11px] text-muted-foreground">
                      Trashed
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </aside>
  );
}
