'use client';

/**
 * What an unbound pane shows: pick an agent conversation, or a shell.
 *
 * The old machine grid's picker offered the two AGENT TYPES of one machine —
 * `pagespace` (Agent) or `shell`. This one offers a choice the old surface
 * could not: WHICH AGENT the conversation belongs to, so a single grid can hold
 * conversations with several different agents side by side.
 *
 * Presentational, like `PaneBar`: it renders choices and reports them. Minting
 * a conversation or a shell is IO and belongs to the container, which is also
 * the only thing that knows whether a pick should reuse an existing row.
 */

import { useEffect, useRef } from 'react';
import { Bot, TerminalSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** The picker needs a label and an id — never the whole agent record. */
export interface PickableAgent {
  id: string;
  title: string;
}

export interface PanePickerProps {
  agents: readonly PickableAgent[];
  /** No agents resolved yet — distinct from "this drive has none". */
  isLoading?: boolean;
  /**
   * Takes focus on mount. A split sets this on the pane it just made, so the
   * user lands in the picker rather than a blank rectangle with a control to go
   * hunt for.
   */
  autoFocus?: boolean;
  /** `null` starts a global-assistant conversation, which has no agent page. */
  onPickAgent(agentPageId: string | null): void;
  onPickShell(): void;
}

export default function PanePicker({
  agents,
  isLoading = false,
  autoFocus = false,
  onPickAgent,
  onPickShell,
}: PanePickerProps) {
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (autoFocus) firstRef.current?.focus();
  }, [autoFocus]);

  return (
    <div
      data-testid="pane-picker"
      className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4 text-sm"
    >
      <p className="shrink-0 text-xs font-medium text-muted-foreground">Open in this pane</p>

      <div className="flex min-h-0 flex-col gap-1">
        <Button
          ref={firstRef}
          variant="ghost"
          size="sm"
          className="h-8 justify-start gap-2 px-2"
          onClick={onPickShell}
          data-testid="pick-shell"
        >
          <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          Shell
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="h-8 justify-start gap-2 px-2"
          onClick={() => onPickAgent(null)}
          data-testid="pick-global-assistant"
        >
          <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          Assistant
        </Button>
      </div>

      {/* The agents of this drive. Listed BELOW the two fixed choices rather than
          merged with them: this list is unbounded, and a drive with forty agents
          must not push "Shell" off the top of a short pane. */}
      {isLoading ? (
        <p data-testid="pane-picker-loading" className="text-xs text-muted-foreground">
          Loading agents…
        </p>
      ) : agents.length > 0 ? (
        <div className="flex min-h-0 flex-col gap-1">
          <p className="shrink-0 pt-1 text-xs font-medium text-muted-foreground">Agents</p>
          {agents.map((agent) => (
            <Button
              key={agent.id}
              variant="ghost"
              size="sm"
              className="h-8 justify-start gap-2 px-2"
              onClick={() => onPickAgent(agent.id)}
              data-testid={`pick-agent-${agent.id}`}
            >
              <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{agent.title}</span>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
