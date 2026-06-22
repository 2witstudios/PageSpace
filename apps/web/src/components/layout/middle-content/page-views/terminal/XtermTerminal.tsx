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
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);

      if (cancelled || !containerRef.current) return;

      const terminal = new Terminal({ cursorBlink: true, convertEol: true });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(containerRef.current);
      fitAddon.fit();

      socket.emit('terminal:connect', { pageId, cols: terminal.cols, rows: terminal.rows });

      const onData = terminal.onData((data) => socket.emit('terminal:input', { data }));

      const handleOutput = ({ data }: { data: string }) => terminal.write(data);
      const handleReady = () => onReady?.();
      const handleClosed = ({ exitCode }: { exitCode: number }) =>
        terminal.writeln(`\r\n\x1b[90mProcess exited with code ${exitCode}\x1b[0m`);
      const handleError = ({ message }: { message: string }) => {
        terminal.writeln(`\r\n\x1b[31mError: ${message}\x1b[0m`);
        onError?.(message);
      };

      socket.on('terminal:output', handleOutput);
      socket.on('terminal:ready', handleReady);
      socket.on('terminal:closed', handleClosed);
      socket.on('terminal:error', handleError);

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
        socket.emit('terminal:disconnect');
        terminal.dispose();
      };

      // If cancelled before we got here, tear down immediately
      if (cancelled) teardown();
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, pageId]);

  return <div ref={containerRef} className="w-full h-full" />;
}
