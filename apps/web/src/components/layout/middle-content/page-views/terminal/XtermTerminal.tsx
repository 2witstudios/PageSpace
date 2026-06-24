"use client";

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';

interface XtermTerminalProps {
  socket: Socket;
  pageId: string;
  onReady?(): void;
  onError?(message: string): void;
}

export default function XtermTerminal({ socket, pageId, onReady, onError }: XtermTerminalProps) {
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

        const onData = terminal.onData((data) => socket.emit('terminal:input', { data }));

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

        // Register listeners BEFORE emitting terminal:connect so we don't miss
        // early terminal:ready / terminal:output events from the server.
        socket.on('terminal:output', handleOutput);
        socket.on('terminal:ready', handleReady);
        socket.on('terminal:closed', handleClosed);
        socket.on('terminal:error', handleError);

        socket.emit('terminal:connect', { pageId, cols: terminal.cols, rows: terminal.rows });

        const ro = new ResizeObserver(() => {
          fitAddon.fit();
          socket.emit('terminal:resize', { cols: terminal.cols, rows: terminal.rows });
        });
        ro.observe(containerRef.current!);

        teardown = () => {
          ro.disconnect();
          onData.dispose();
          socket.off('terminal:output', handleOutput);
          socket.off('terminal:ready', handleReady);
          socket.off('terminal:closed', handleClosed);
          socket.off('terminal:error', handleError);
          terminal.dispose();
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
  // onReady/onError are intentionally omitted — callers must stabilise them with
  // useCallback. Including them would re-mount the terminal on every parent render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, pageId]);

  return <div ref={containerRef} className="w-full h-full" />;
}
