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
  /**
   * Set only for a cross-drive list (a global-assistant session's picker
   * spans every accessible drive) — page titles aren't unique, so two drives
   * can hold identically-titled agents that would otherwise be
   * indistinguishable in the list.
   */
  driveName?: string;
}

/** A shell already open in this session but not currently shown in any pane. */
export interface ReattachableShell {
  shellId: string;
  name: string;
}

export interface PanePickerProps {
  agents: readonly PickableAgent[];
  /** No agents resolved yet — distinct from "this drive has none". */
  isLoading?: boolean;
  /**
   * Shells this session already has running, not bound to any pane right
   * now — offered above "Shell" so reopening one is a click rather than a
   * dead end (issue #2263, finding 3: closing a terminal pane used to have
   * no way back to it short of the sidebar's stale count).
   */
  existingShells?: readonly ReattachableShell[];
  /**
   * Takes focus on mount. A split sets this on the pane it just made, so the
   * user lands in the picker rather than a blank rectangle with a control to go
   * hunt for.
   */
  autoFocus?: boolean;
  /**
   * Whether the global assistant is offerable. The identity path exists
   * (`AssistantSessionChat` rides the global chat pipeline), so the one
   * production caller passes true; the flag remains so a host without that
   * renderer can withhold the choice rather than offer a pick with no
   * supplier.
   */
  canPickAssistant?: boolean;
  /** `null` starts a global-assistant conversation, which has no agent page. */
  onPickAgent(agentPageId: string | null): void;
  onPickShell(): void;
  /** Bind this pane to an already-running shell instead of spawning a new one. */
  onReattachShell?(shellId: string, name: string): void;
}

export default function PanePicker({
  agents,
  isLoading = false,
  autoFocus = false,
  canPickAssistant = false,
  existingShells = [],
  onPickAgent,
  onPickShell,
  onReattachShell,
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

      {/* `shrink-0`, not `min-h-0`: none of this picker's sub-lists scroll on
          their own (the root `overflow-auto` above is the only scroll
          region), so a sub-list must never be allowed to shrink below its
          buttons' height — `min-h-0` on a non-scrolling flex item just lets
          the outer column crush it under space pressure while its buttons
          (already `shrink-0` via the Button component) refuse to shrink,
          which pushes their overflow into the next section instead of
          scrolling — exactly what made a short split pane's "Global
          Assistant" button visually collide with "Agents" and eat its
          clicks. */}
      <div className="flex shrink-0 flex-col gap-1">
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

        {canPickAssistant && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 justify-start gap-2 px-2"
            onClick={() => onPickAgent(null)}
            data-testid="pick-global-assistant"
          >
            <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            Global Assistant
          </Button>
        )}
      </div>

      {/* Shells this session already has, not shown anywhere right now — above
          the drive's agents since reattaching an existing thing outranks
          spawning a new one. */}
      {existingShells.length > 0 && (
        <div className="flex shrink-0 flex-col gap-1">
          <p className="shrink-0 pt-1 text-xs font-medium text-muted-foreground">Reattach a shell</p>
          {existingShells.map((shell) => (
            <Button
              key={shell.shellId}
              variant="ghost"
              size="sm"
              className="h-8 justify-start gap-2 px-2"
              onClick={() => onReattachShell?.(shell.shellId, shell.name)}
              data-testid={`reattach-shell-${shell.shellId}`}
            >
              <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate">{shell.name}</span>
            </Button>
          ))}
        </div>
      )}

      {/* The agents of this drive. Listed BELOW the two fixed choices rather than
          merged with them: this list is unbounded, and a drive with forty agents
          must not push "Shell" off the top of a short pane. */}
      {isLoading ? (
        <p data-testid="pane-picker-loading" className="text-xs text-muted-foreground">
          Loading agents…
        </p>
      ) : agents.length > 0 ? (
        <div className="flex shrink-0 flex-col gap-1">
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
              {agent.driveName && (
                <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{agent.driveName}</span>
              )}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
