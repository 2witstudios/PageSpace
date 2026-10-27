'use client';

/**
 * Shell — the terminal pane's leaf for one PTY.
 *
 * Thin wrapper: resolves the one shared socket (`useSocket`) and hands it to
 * `XtermTerminal` keyed by `shellId` — the whole address a shell needs. Renders
 * a connecting placeholder while the socket is still being acquired (first
 * paint, or a post-auth-refresh reconnect) rather than mounting `XtermTerminal`
 * with no socket to bind to.
 *
 * the pane grid keeps shell panes mounted (hidden, not unmounted) across layout changes. No extra "fit on reveal"
 * wiring is needed here: `XtermTerminal`'s own `ResizeObserver` already fires
 * when a hidden (0×0) container regains real size, which is exactly the
 * transition a tab switch produces.
 *
 * A socket that never connects used to leave a blank terminal and no word of why
 * (in Imago that is most often realtime refusing the page's origin). After
 * `STALLED_AFTER_MS` without a connection the pane says so over the terminal,
 * which stays mounted and binds the moment the socket comes up.
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useSocket } from '@/retained/hooks/useSocket';
import { useSocketStore } from '@/retained/stores/useSocketStore';
import XtermTerminal from './XtermTerminal';

export const STALLED_AFTER_MS = 8000;

/** Whether the shared socket has gone `STALLED_AFTER_MS` without connecting. */
function useConnectionStalled(): boolean {
  const connected = useSocketStore((state) => state.connectionStatus === 'connected');
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (connected) return;
    const timer = setTimeout(() => setStalled(true), STALLED_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connected]);
  return stalled && !connected;
}

export interface ShellProps {
  /** The shell's display label, used to name the terminal region so multiple shells are distinguishable to a screen reader. */
  name?: string;
  /** The whole address — everything connect/resize/kill/editing-store needs. */
  shellId: string;
  initialInput?: string;
  onInitialInputSent?(): void;
  onReady?(): void;
  onError?(message: string): void;
}

export default function Shell({ shellId, name, initialInput, onInitialInputSent, onReady, onError }: ShellProps) {
  const socket = useSocket();
  const stalled = useConnectionStalled();

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
    <div className="relative h-full min-h-0">
      <XtermTerminal
        socket={socket}
        shellId={shellId}
        initialInput={initialInput}
        onInitialInputSent={onInitialInputSent}
        onReady={onReady}
        onError={onError}
        ariaLabel={name ? `Shell ${name}` : undefined}
      />
      {stalled && (
        <div
          role="status"
          data-testid="shell-stalled"
          className="absolute inset-x-0 top-0 flex items-center gap-2 bg-background/90 px-3 py-2 text-xs text-muted-foreground"
        >
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          Can&apos;t reach the realtime server. Retrying…
        </div>
      )}
    </div>
  );
}
