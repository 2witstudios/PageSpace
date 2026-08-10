"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { agentDiffs } from "@/lib/mock/diffs";
import type { DiffFile, DiffLine, DiffScope } from "@/lib/mock/types";
import DiffStatChip from "@/components/fleet/DiffStatChip";

const SCOPE_LABELS: Record<DiffScope, string> = {
  uncommitted: "Uncommitted",
  committed: "Committed",
  // "vs default", not "vs master" — the default branch is whatever the repo says
  // it is (the DiffTab lesson, kept).
  branch: "Branch vs default",
};

const LINE_TONE: Record<DiffLine["kind"], string> = {
  hunk: "bg-info/10 text-info",
  add: "bg-success/10 text-success",
  del: "bg-destructive/10 text-destructive",
  context: "text-muted-foreground",
};

function emptyMessage(scope: DiffScope, branch: string | undefined): string {
  const name = branch ?? "this checkout";
  if (scope === "uncommitted") return `No uncommitted changes on ${name}`;
  if (scope === "committed") return `No committed changes on ${name}`;
  return `${name} is identical to the default branch`;
}

/** One changed file: a cheap header row that expands into the diff body on demand. */
export function DiffFileCard({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-md border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/40"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
        <DiffStatChip diff={{ additions: file.additions, deletions: file.deletions, files: 1 }} className="shrink-0 [&>*:last-child]:hidden" />
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-border bg-background/60 py-1">
          {file.lines.map((line, i) => (
            <div key={i} className={cn("whitespace-pre px-3 font-mono text-[11px] leading-5", LINE_TONE[line.kind])}>
              {line.kind === "add" ? "+ " : line.kind === "del" ? "− " : "  "}
              {line.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Scoped diff over one agent's checkout: 3-way scope toggle above expandable
 * per-file cards — DiffTab's shape, minus the tree (the agent IS the branch).
 */
export default function DiffPanel({ agentId, branch }: { agentId: string; branch: string | undefined }) {
  const [scope, setScope] = useState<DiffScope>("uncommitted");
  const files = agentDiffs[agentId]?.[scope] ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-3 p-4">
      <Tabs value={scope} onValueChange={(v) => setScope(v as DiffScope)}>
        <TabsList>
          {(Object.keys(SCOPE_LABELS) as DiffScope[]).map((s) => (
            <TabsTrigger key={s} value={s} className="text-xs">
              {SCOPE_LABELS[s]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {files.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <FileDiff className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{emptyMessage(scope, branch)}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {files.map((file) => (
            <DiffFileCard key={file.path} file={file} />
          ))}
        </div>
      )}
    </div>
  );
}
