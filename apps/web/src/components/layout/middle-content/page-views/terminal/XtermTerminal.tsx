"use client";

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { Terminal as XtermTerminalInstance } from '@xterm/xterm';
import { useEditingStore } from '@/stores/useEditingStore';
import { useXtermTheme } from '@/hooks/useXtermTheme';
import { getCssVar } from '@/lib/theme/css-color-resolution';

const FALLBACK_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace";

export interface AgentTerminalConnectPayload {
  machineId: string;
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
  const terminalRef = useRef<XtermTerminalInstance | null>(null);
  const theme = useXtermTheme();
  // Read at creation time only — the connect effect below is intentionally
  // NOT keyed on `theme` (see its own comment), so later theme changes are
  // pushed live via the effect further down instead of through this ref.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // Live theme updates without tearing down the [socket, sessionId]-keyed
  // connection effect — xterm supports assigning `options.theme` directly.
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = theme;
    }
  }, [theme]);

  useEffect(() => {
    if (!containerRef.current) return;

    let cancelled = false;
    let teardown: (() => void) | undefined;

    // The Terminal workspace's splittable panes all share ONE socket (one
    // connection per browser tab, not per pane) — this id is how the realtime
    // bridge (and this listener) tells this pane's PTY stream apart from a
    // sibling pane's on the exact same socket. Fresh per mount; switching
    // scope re-mounts (keyed by sessionId at the call site) and gets a new one.
    const connectionId = crypto.randomUUID();

    void (async () => {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ]);

        if (cancelled || !containerRef.current) return;

        const fontFamily = getCssVar('--font-mono') || FALLBACK_FONT_FAMILY;
        const terminal = new Terminal({
          cursorBlink: true,
          theme: themeRef.current,
          fontFamily,
          fontSize: 13,
          cursorStyle: 'bar',
          letterSpacing: 0,
          lineHeight: 1.35,
        });
        terminalRef.current = terminal;
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(containerRef.current);
        fitAddon.fit();

        const onData = terminal.onData((data) => socket.emit('agent-terminal:input', { data, connectionId }));

        // Every mounted XtermTerminal shares this one socket, so every one of
        // its listeners sees every pane's events — drop anything tagged with
        // a DIFFERENT connectionId rather than rendering it into this pane.
        const isMine = (payload: { connectionId?: string } | undefined) =>
          payload?.connectionId === undefined || payload.connectionId === connectionId;

        const handleOutput = (payload: { data: string; connectionId?: string }) => {
          if (!isMine(payload)) return;
          terminal.write(payload.data);
        };
        const handleReady = (payload: { scrollback?: string; connectionId?: string } = {}) => {
          if (!isMine(payload)) return;
          if (payload.scrollback) terminal.write(payload.scrollback);
          useEditingStore.getState().startEditing(sessionId, 'other', { componentName: 'agent-terminal' });
          onReady?.();
        };
        const handleClosed = (payload: { exitCode: number; connectionId?: string }) => {
          if (!isMine(payload)) return;
          terminal.writeln(`\r\n\x1b[90mProcess exited with code ${payload.exitCode}\x1b[0m`);
        };
        const handleError = (payload: { message: string; connectionId?: string }) => {
          if (!isMine(payload)) return;
          terminal.writeln(`\r\n\x1b[31mError: ${payload.message}\x1b[0m`);
          onError?.(payload.message);
        };

        // Register listeners BEFORE emitting agent-terminal:connect so we don't
        // miss early agent-terminal:ready / agent-terminal:output events.
        socket.on('agent-terminal:output', handleOutput);
        socket.on('agent-terminal:ready', handleReady);
        socket.on('agent-terminal:closed', handleClosed);
        socket.on('agent-terminal:error', handleError);

        // A kept-alive terminal is CSS-hidden (display:none) when its page is
        // not the active tab. While hidden the container has zero size, so any
        // fit() would compute garbage cols/rows and emit a bogus 0-wide resize
        // to the PTY. Gate on real visibility: the ResizeObserver still fires
        // when the container goes from display:none back to a real size, so
        // re-showing a hidden terminal triggers exactly one correct refit.
        const isVisible = () => {
          const el = containerRef.current;
          return !!el && el.offsetParent !== null && el.clientWidth > 0 && el.clientHeight > 0;
        };

        const resize: { observer?: ResizeObserver } = {};
        teardown = () => {
          resize.observer?.disconnect();
          onData.dispose();
          socket.off('agent-terminal:output', handleOutput);
          socket.off('agent-terminal:ready', handleReady);
          socket.off('agent-terminal:closed', handleClosed);
          socket.off('agent-terminal:error', handleError);
          // Tell the server THIS pane is gone (not the whole socket) — with
          // several panes multiplexed over one socket, only an explicit
          // per-connection signal (not the socket's own disconnect/idle
          // timeout) correctly reflects "this one pane closed".
          socket.emit('agent-terminal:disconnect', { connectionId });
          terminal.dispose();
          if (terminalRef.current === terminal) {
            terminalRef.current = null;
          }
          useEditingStore.getState().endEditing(sessionId);
        };

        // The tracking row for this scope must already exist — the Navigator's
        // add-terminal dialog reserves it (spawnAgentTerminal) before it's ever
        // offered as something to open, so connecting here only ever attaches
        // to (or resumes) an already-known session.
        socket.emit('agent-terminal:connect', { ...connectPayload, connectionId, cols: terminal.cols, rows: terminal.rows });

        resize.observer = new ResizeObserver(() => {
          // Skip while hidden (0×0) — avoids garbage fits and 0-wide resizes.
          // Fires again with correct dims when the pane is re-shown.
          if (!isVisible()) return;
          fitAddon.fit();
          socket.emit('agent-terminal:resize', { cols: terminal.cols, rows: terminal.rows, connectionId });
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
