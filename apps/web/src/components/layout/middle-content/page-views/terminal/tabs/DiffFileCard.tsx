"use client";

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMachineDiffPair } from '@/hooks/useMachineDiff';
import type { MachineDiffFile, MachineDiffScope } from '@pagespace/lib/services/sandbox/machine-diff-scope';

// Monaco owns `window`/`document` at import time — never SSR it.
const MonacoDiffEditor = dynamic(() => import('@/components/editors/MonacoDiffEditor'), { ssr: false });

const STATUS_STYLES: Record<MachineDiffFile['status'], string> = {
  added: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  modified: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  deleted: 'bg-red-500/10 text-red-600 dark:text-red-400',
  renamed: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
};

interface DiffFileCardProps {
  machineId: string;
  projectName: string;
  branchName: string;
  scope: MachineDiffScope;
  file: MachineDiffFile;
}

/**
 * One changed file, collapsed to a header row until opened. Its diff pair is
 * fetched ONLY while expanded (`useMachineDiffPair`'s `enabled`), so a scope
 * with many changed files costs one list request, not N content requests.
 */
export default function DiffFileCard({ machineId, projectName, branchName, scope, file }: DiffFileCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { data, error, isLoading } = useMachineDiffPair(
    machineId,
    projectName,
    branchName,
    scope,
    file,
    expanded,
  );

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate font-mono text-xs">{file.path}</span>
        {file.previousPath && (
          // A COPY also carries a previousPath but is statused 'added' (see
          // parseNameStatusZ), so name the relationship rather than showing a
          // bare arrow that reads like a rename wearing the wrong badge.
          <span className="truncate font-mono text-xs text-muted-foreground">
            {file.status === 'renamed' ? 'renamed from' : 'copied from'} {file.previousPath}
          </span>
        )}
        <span className={cn('ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', STATUS_STYLES[file.status])}>
          {file.status}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border">
          {isLoading && <div className="px-3 py-4 text-xs text-muted-foreground">Loading diff…</div>}
          {error && <div className="px-3 py-4 text-xs text-destructive">Failed to load diff: {error.message}</div>}
          {!isLoading && !error && data && !data.notApplicable && (
            <>
              {(data.original?.truncated || data.modified?.truncated) && (
                // Diffing a CUT-OFF side against a whole one paints the file's
                // entire tail as removed/added lines that never changed — so a
                // truncated side has to be called out, never rendered as if it
                // were the complete file.
                <div className="border-b border-border bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  This file is too large to load in full — it is cut off below, so changes near the end may be
                  missing or shown incorrectly.
                </div>
              )}
              <div className="h-[420px]">
                <MonacoDiffEditor
                  // A null side means the file doesn't exist there (added → no
                  // original, deleted → no modified). Each side carries its own
                  // content + truncated flag; Monaco needs the string.
                  original={data.original?.content ?? ''}
                  modified={data.modified?.content ?? ''}
                  filename={file.path}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
