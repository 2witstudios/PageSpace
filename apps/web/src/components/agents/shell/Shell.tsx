'use client';

/**
 * Shell — the `AgentView` tab leaf for one PTY.
 *
 * Thin wrapper: resolves the one shared socket (`useSocket`) and hands it to
 * `XtermTerminal` keyed by `shellId` — the whole address a shell needs. Renders
 * a connecting placeholder while the socket is still being acquired (first
 * paint, or a post-auth-refresh reconnect) rather than mounting `XtermTerminal`
 * with no socket to bind to.
 *
 * `AgentView`'s tab container force-mounts every shell tab and CSS-hides the
 * inactive ones (never unmounts — a closed tab is a DELETE, not a hide), so a
 * shell's PTY and scrollback survive switching tabs. No extra "fit on reveal"
 * wiring is needed here: `XtermTerminal`'s own `ResizeObserver` already fires
 * when a hidden (0×0) container regains real size, which is exactly the
 * transition a tab switch produces.
 */
import { Loader2 } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import XtermTerminal from './XtermTerminal';

export interface ShellProps {
  /** The whole address — everything connect/resize/kill/editing-store needs. */
  shellId: string;
  initialInput?: string;
  onInitialInputSent?(): void;
  onReady?(): void;
  onError?(message: string): void;
}

export default function Shell({ shellId, initialInput, onInitialInputSent, onReady, onError }: ShellProps) {
  const socket = useSocket();

  if (!socket) {
    return (
      <div
        data-testid="shell-connecting"
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <Loader2 className="size-4 animate-spin" />
        Connecting…
      </div>
    );
  }

  return (
    <XtermTerminal
      socket={socket}
      shellId={shellId}
      initialInput={initialInput}
      onInitialInputSent={onInitialInputSent}
      onReady={onReady}
      onError={onError}
    />
  );
}
