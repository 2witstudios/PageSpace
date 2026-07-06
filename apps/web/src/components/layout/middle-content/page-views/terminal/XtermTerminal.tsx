"use client";

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { useCSRFToken } from '@/hooks/useCSRFToken';

interface XtermTerminalProps {
  socket: Socket;
  pageId: string;
  onReady?(): void;
  onError?(message: string): void;
}

/**
 * A plain machine shell IS a machine-scope agent terminal of `agentType:
 * 'shell'` (Terminal — universal scope reshape) — this conventional name is
 * what the realtime agent-terminal-activity feed (apps/realtime/src/
 * terminal/terminal-activity.ts) also assumes when injecting agent bash runs
 * into this same live PTY feed.
 */
const SHELL_TERMINAL_NAME = 'shell';

export default function XtermTerminal({ socket, pageId, onReady, onError }: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { refreshToken } = useCSRFToken();

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
          onReady?.();
        };
        const handleClosed = ({ exitCode }: { exitCode: number }) =>
          terminal.writeln(`\r\n\x1b[90mProcess exited with code ${exitCode}\x1b[0m`);
        const handleError = ({ message }: { message: string }) => {
          terminal.writeln(`\r\n\x1b[31mError: ${message}\x1b[0m`);
          onError?.(message);
        };

        // Register listeners BEFORE spawning/connecting so we don't miss early
        // agent-terminal:ready / agent-terminal:output events from the server.
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
        };

        // Reserve the (machine-scope, 'shell') tracking row — idempotent, so a
        // repeat mount/reconnect just resumes it — before opening the PTY
        // connection, mirroring "spawn reserves the row, PTY opens lazily on
        // connect" (agent-terminals.ts).
        const csrfToken = await refreshToken();
        if (!csrfToken) throw new Error('Failed to obtain a CSRF token');
        const spawnResponse = await fetch('/api/machines/agent-terminals', {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ terminalId: pageId, name: SHELL_TERMINAL_NAME, agentType: SHELL_TERMINAL_NAME }),
        });
        if (cancelled) { teardown(); return; }
        if (!spawnResponse.ok) {
          const errorBody: unknown = await spawnResponse.json().catch(() => null);
          const message =
            typeof errorBody === 'object' && errorBody !== null && 'error' in errorBody && typeof (errorBody as { error: unknown }).error === 'string'
              ? (errorBody as { error: string }).error
              : 'Failed to open machine shell';
          throw new Error(message);
        }

        socket.emit('agent-terminal:connect', { terminalId: pageId, name: SHELL_TERMINAL_NAME, cols: terminal.cols, rows: terminal.rows });

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
  // onReady/onError are intentionally omitted — callers must stabilise them with
  // useCallback. Including them would re-mount the terminal on every parent render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, pageId]);

  return <div ref={containerRef} className="w-full h-full" />;
}
