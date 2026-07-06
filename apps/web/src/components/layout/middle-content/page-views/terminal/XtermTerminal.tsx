"use client";

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { useEditingStore } from '@/stores/useEditingStore';

interface XtermTerminalProps {
  socket: Socket;
  /**
   * Uniquely identifies this PTY session (e.g. `terminal:${pageId}` for a
   * human Machine shell, or `agent-terminal:${terminalId}:${projectName}:
   * ${branchName}:${name}` for a workspace agent-terminal pane). Used as the
   * effect's re-connect key and as the useEditingStore session id.
   */
  sessionId: string;
  /** Which realtime event family to speak — see apps/realtime/src/terminal/. Defaults to the human Machine shell. */
  eventPrefix?: 'terminal' | 'agent-terminal';
  /** Payload merged with `{ cols, rows }` on `${eventPrefix}:connect` — e.g. `{ pageId }` or `{ terminalId, projectName, branchName, name }`. */
  connectPayload: Record<string, unknown>;
  onReady?(): void;
  onError?(message: string): void;
}

export default function XtermTerminal({
  socket,
  sessionId,
  eventPrefix = 'terminal',
  connectPayload,
  onReady,
  onError,
}: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let teardown: (() => void) | undefined;

    void (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);

        if (cancelled || !containerRef.current) return;

        const terminal = new Terminal({ cursorBlink: true });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(containerRef.current);
        fitAddon.fit();

        const onData = terminal.onData((data) => socket.emit(`${eventPrefix}:input`, { data }));

        const handleOutput = ({ data }: { data: string }) => terminal.write(data);
        const handleReady = ({ scrollback }: { scrollback?: string } = {}) => {
          if (scrollback) terminal.write(scrollback);
          useEditingStore.getState().startEditing(sessionId, 'other', { componentName: eventPrefix });
          onReady?.();
        };
        const handleClosed = ({ exitCode }: { exitCode: number }) =>
          terminal.writeln(`\r\n\x1b[90mProcess exited with code ${exitCode}\x1b[0m`);
        const handleError = ({ message }: { message: string }) => {
          terminal.writeln(`\r\n\x1b[31mError: ${message}\x1b[0m`);
          onError?.(message);
        };

        // Register listeners BEFORE emitting ${eventPrefix}:connect so we don't
        // miss early ${eventPrefix}:ready / ${eventPrefix}:output events.
        socket.on(`${eventPrefix}:output`, handleOutput);
        socket.on(`${eventPrefix}:ready`, handleReady);
        socket.on(`${eventPrefix}:closed`, handleClosed);
        socket.on(`${eventPrefix}:error`, handleError);

        socket.emit(`${eventPrefix}:connect`, { ...connectPayload, cols: terminal.cols, rows: terminal.rows });

        const ro = new ResizeObserver(() => {
          fitAddon.fit();
          socket.emit(`${eventPrefix}:resize`, { cols: terminal.cols, rows: terminal.rows });
        });
        ro.observe(containerRef.current!);

        teardown = () => {
          ro.disconnect();
          onData.dispose();
          socket.off(`${eventPrefix}:output`, handleOutput);
          socket.off(`${eventPrefix}:ready`, handleReady);
          socket.off(`${eventPrefix}:closed`, handleClosed);
          socket.off(`${eventPrefix}:error`, handleError);
          terminal.dispose();
          useEditingStore.getState().endEditing(sessionId);
        };

        if (cancelled) teardown();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to initialize terminal';
        onError?.(message);
      }
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
  // onReady/onError/connectPayload are intentionally omitted — callers must
  // treat connectPayload as stable for a given sessionId (bump sessionId
  // instead of mutating it in place) and stabilise onReady/onError with
  // useCallback. Including them would re-mount the terminal on every parent
  // render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, sessionId, eventPrefix]);

  return <div ref={containerRef} className="w-full h-full" />;
}
