"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CornerDownLeft, SquareSplitHorizontal, SquareSplitVertical, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { Agent, AgentRuntime, TranscriptLine } from "@/lib/mock/types";

interface Pane {
  id: string;
  /** null = empty pane showing the agent picker (split-and-pick). */
  runtime: AgentRuntime | null;
  title: string;
}

let paneSeq = 0;
const mintPaneId = () => `pane-${++paneSeq}`;

const LINE_TONE: Record<TranscriptLine["kind"], string> = {
  command: "text-foreground",
  output: "text-muted-foreground",
  agent: "text-info",
  system: "text-warning/80 italic",
};

function MockScrollback({ transcript, appended }: { transcript: TranscriptLine[]; appended: TranscriptLine[] }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [appended.length]);

  return (
    <div className="h-full overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed">
      {[...transcript, ...appended].map((line, i) => (
        <div key={i} className={cn("whitespace-pre-wrap", LINE_TONE[line.kind])}>
          {line.text}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

/** Split-and-pick: an empty pane IS the picker — choosing a runtime fills it. */
function AgentPicker({ onPick }: { onPick: (runtime: AgentRuntime) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <div className="text-sm text-muted-foreground">Spawn into this pane</div>
      <div className="flex gap-2">
        {(["claude", "codex", "terminal"] as const).map((runtime) => (
          <Button key={runtime} variant="outline" size="sm" className="capitalize" onClick={() => onPick(runtime)}>
            {runtime}
          </Button>
        ))}
      </div>
      <p className="max-w-52 text-xs text-muted-foreground">
        The session is named for you and bound to this pane the moment it boots.
      </p>
    </div>
  );
}

function TerminalPane({
  pane,
  agent,
  canClose,
  onSplitRight,
  onSplitDown,
  onClose,
  onPick,
}: {
  pane: Pane;
  agent: Agent;
  canClose: boolean;
  onSplitRight(): void;
  onSplitDown(): void;
  onClose(): void;
  onPick(runtime: AgentRuntime): void;
}) {
  const [input, setInput] = useState("");
  const [appended, setAppended] = useState<TranscriptLine[]>([]);
  const primary = pane.runtime !== null && pane.id === "pane-main";

  const send = () => {
    const text = input.trim();
    if (!text) return;
    setAppended((prev) => [
      ...prev,
      { kind: "command", text: `> ${text}` },
      { kind: "system", text: "mock session — input goes nowhere yet" },
    ]);
    setInput("");
  };

  return (
    <div className="group/pane flex h-full flex-col bg-background">
      <div className="flex items-center gap-1.5 border-b border-[var(--separator)] px-2 py-1">
        <span className="truncate font-mono text-[11px] text-muted-foreground">{pane.title}</span>
        <div className="flex-1" />
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/pane:opacity-100">
          <button
            type="button"
            title="Split right"
            aria-label="Split right"
            onClick={onSplitRight}
            className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <SquareSplitHorizontal className="size-3.5" />
          </button>
          <button
            type="button"
            title="Split down"
            aria-label="Split down"
            onClick={onSplitDown}
            className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <SquareSplitVertical className="size-3.5" />
          </button>
          {canClose && (
            <button
              type="button"
              title="Close pane"
              aria-label="Close pane"
              onClick={onClose}
              className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {pane.runtime === null ? (
        <AgentPicker onPick={onPick} />
      ) : (
        <>
          <div className="min-h-0 flex-1">
            <MockScrollback
              transcript={primary ? agent.transcript : [{ kind: "system", text: `fresh ${pane.runtime} session in ${pane.title}` }]}
              appended={appended}
            />
          </div>
          <div className="flex items-center gap-2 border-t border-[var(--separator)] px-2 py-1.5">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder={`Send to ${agent.name}…`}
              className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/60"
            />
            <button
              type="button"
              aria-label="Send"
              onClick={send}
              className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <CornerDownLeft className="size-3.5" />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The workspace pane grid, mocked: one row of columns where each column may
 * split into two stacked panes. Real nesting (arbitrary trees) arrives with
 * the backend phase; this keeps the split feel with a fraction of the state.
 */
export default function TerminalPaneGrid({ agent }: { agent: Agent }) {
  const [columns, setColumns] = useState<Pane[][]>([
    [{ id: "pane-main", runtime: agent.runtime, title: agent.name }],
  ]);

  const paneCount = columns.reduce((n, col) => n + col.length, 0);

  const splitRight = (colIdx: number) => {
    if (columns.length >= 3) {
      toast("Mock grid caps at 3 columns");
      return;
    }
    setColumns((cols) => [
      ...cols.slice(0, colIdx + 1),
      [{ id: mintPaneId(), runtime: null, title: "new pane" }],
      ...cols.slice(colIdx + 1),
    ]);
  };

  const splitDown = (colIdx: number) => {
    if (columns[colIdx].length >= 2) {
      toast("Mock grid caps at 2 rows per column");
      return;
    }
    setColumns((cols) =>
      cols.map((col, i) => (i === colIdx ? [...col, { id: mintPaneId(), runtime: null, title: "new pane" }] : col)),
    );
  };

  const close = (paneId: string) => {
    setColumns((cols) => cols.map((col) => col.filter((p) => p.id !== paneId)).filter((col) => col.length > 0));
  };

  const pick = (paneId: string, runtime: AgentRuntime) => {
    setColumns((cols) =>
      cols.map((col) =>
        col.map((p) => (p.id === paneId ? { ...p, runtime, title: `${runtime}-${p.id.slice(5)}` } : p)),
      ),
    );
  };

  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      {columns.map((col, colIdx) => (
        <Fragment key={col[0].id}>
          {colIdx > 0 && <ResizableHandle variant="chrome-free" />}
          <ResizablePanel minSize={15}>
            {col.length === 1 ? (
              <TerminalPane
                pane={col[0]}
                agent={agent}
                canClose={paneCount > 1}
                onSplitRight={() => splitRight(colIdx)}
                onSplitDown={() => splitDown(colIdx)}
                onClose={() => close(col[0].id)}
                onPick={(runtime) => pick(col[0].id, runtime)}
              />
            ) : (
              <ResizablePanelGroup orientation="vertical">
                {col.map((pane, rowIdx) => (
                  <Fragment key={pane.id}>
                    {rowIdx > 0 && <ResizableHandle variant="chrome-free" />}
                    <ResizablePanel minSize={15}>
                      <TerminalPane
                        pane={pane}
                        agent={agent}
                        canClose
                        onSplitRight={() => splitRight(colIdx)}
                        onSplitDown={() => splitDown(colIdx)}
                        onClose={() => close(pane.id)}
                        onPick={(runtime) => pick(pane.id, runtime)}
                      />
                    </ResizablePanel>
                  </Fragment>
                ))}
              </ResizablePanelGroup>
            )}
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}
