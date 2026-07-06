"use client";

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { useEditingStore } from '@/stores/useEditingStore';

export interface AgentTerminalConnectPayload {
  terminalId: string;
  /** Neither set → machine scope, projectName alone → project scope, both → branch scope (see `agent-terminals.ts`). */
  projectName?: string;
  branchName?: string;
  name: string;
}

interface XtermTerminalProps {
  socket: Socket;
  /** Uniquely identifies this PTY session's scope tuple — used as the effect's re-connect key and the useEditingStore session id. Callers should key their component with this same value so switching scope re-mounts instead of reusing stale listeners. */
  sessionId: string;
  connectPayload: AgentTerminalConnectPayload;
  onReady?(): void;
  onError?(message: string): void;
}

export default function XtermTerminal({ socket, sessionId, connectPayload, onReady, onError }: XtermTerminalProps) {
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

        const onData = terminal.onData((data) => socket.emit('agent-terminal:input', { data }));

        const handleOutput = ({ data }: { data: string }) => terminal.write(data);
        const handleReady = ({ scrollback }: { scrollback?: string } = {}) => {
          if (scrollback) terminal.write(scrollback);
          useEditingStore.getState().startEditing(sessionId, 'other', { componentName: 'agent-terminal' });
          onReady?.();
        };
        const handleClosed = ({ exitCode }: { exitCode: number }) =>
          terminal.writeln(`\r\n\x1b[90mProcess exited with code ${exitCode}\x1b[0m`);
        const handleError = ({ message }: { message: string }) => {
          terminal.writeln(`\r\n\x1b[31mError: ${message}\x1b[0m`);
          onError?.(message);
        };

        // Register listeners BEFORE emitting agent-terminal:connect so we don't
        // miss early agent-terminal:ready / agent-terminal:output events.
        socket.on('agent-terminal:output', handleOutput);
        socket.on('agent-terminal:ready', handleReady);
        socket.on('agent-terminal:closed', handleClosed);
        socket.on('agent-terminal:error', handleError);

        const resize: { observer?: ResizeObserver } = {};
        teardown = () => {
          resize.observer?.disconnect();
          onData.dispose();
          socket.off('agent-terminal:output', handleOutput);
          socket.off('agent-terminal:ready', handleReady);
          socket.off('agent-terminal:closed', handleClosed);
          socket.off('agent-terminal:error', handleError);
          terminal.dispose();
          useEditingStore.getState().endEditing(sessionId);
        };

        // The tracking row for this scope must already exist — the Navigator's
        // add-terminal dialog reserves it (spawnAgentTerminal) before it's ever
        // offered as something to open, so connecting here only ever attaches
        // to (or resumes) an already-known session.
        socket.emit('agent-terminal:connect', { ...connectPayload, cols: terminal.cols, rows: terminal.rows });

        resize.observer = new ResizeObserver(() => {
          fitAddon.fit();
          socket.emit('agent-terminal:resize', { cols: terminal.cols, rows: terminal.rows });
        });
        resize.observer.observe(containerRef.current!);

        if (cancelled) teardown();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to initialize terminal';
        onError?.(message);
        teardown?.();
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
  }, [socket, sessionId]);

  return <div ref={containerRef} className="w-full h-full" />;
}
