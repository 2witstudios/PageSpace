"use client";

import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import type { Terminal as XtermTerminalInstance } from '@xterm/xterm';
import { useEditingStore } from '@/stores/useEditingStore';
import { useXtermTheme } from '@/hooks/useXtermTheme';
import { getCssVar } from '@/lib/theme/css-color-resolution';
import { toPtyInput } from './pty-input';

const FALLBACK_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Monaco, 'Courier New', monospace";

/** How long to wait for a cold agent to print something before writing the
 * starting prompt anyway. Some agents boot silently; the prompt still has to
 * go in, and a wait this short is invisible next to a Sprite cold boot. */
const PROMPT_BACKSTOP_MS = 3000;

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
  /** Typed into the PTY (with a trailing newline) once it's ready — the optional starting prompt from the pane's agent picker. Sent AT MOST ONCE per mount; the caller must drop it (see `onInitialInputSent`) so a later re-mount doesn't retype it at a running agent. */
  initialInput?: string;
  onInitialInputSent?(): void;
  onReady?(): void;
  onError?(message: string): void;
}

export default function XtermTerminal({ socket, sessionId, connectPayload, initialInput, onInitialInputSent, onReady, onError }: XtermTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminalInstance | null>(null);
  // Read at ready-time, not captured in the connect effect's deps — same reason
  // as onReady/onError below: this component must not re-mount (and re-attach
  // its PTY) just because the parent re-rendered with a new closure.
  const initialInputRef = useRef({ input: initialInput, onSent: onInitialInputSent });
  initialInputRef.current = { input: initialInput, onSent: onInitialInputSent };
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

        /**
         * The starting prompt goes in as INPUT, exactly as if the user had typed
         * it — the agent CLI is the PTY's foreground process, so it reads the
         * line off its own stdin.
         *
         * WHEN it goes in matters. On a cold start the bridge emits `ready` the
         * moment the binary is exec'd, which is not the moment an interactive
         * agent (a raw-mode TUI) starts reading stdin — writing into that window
         * risks the prompt being discarded as the app takes over the tty. So the
         * write waits for the agent's FIRST OUTPUT (it is up and drawing), with a
         * timer as the backstop for an agent that prints nothing on boot.
         *
         * IT ONLY EVER LANDS IN A FRESH BOOT. An agent that is already running has
         * reached some state of its own — a half-typed answer, a `y/n`
         * confirmation — and a line plus a carriage return arriving there is
         * destructive. Two signals say the PTY was already alive, and the prompt
         * is DISCARDED (spent, not written) on either:
         *
         *   - `resumed`, from the bridge: it picked up a Sprite exec session that
         *     was still running. This is the one the client cannot infer — after a
         *     realtime restart, a connect to an agent running for hours takes the
         *     bridge's CREATE path and would otherwise look exactly like a cold
         *     boot.
         *   - a NON-EMPTY `scrollback`: a reattach to a PTY that has already
         *     printed. (An empty scrollback is a reattach to a PTY that has
         *     emitted nothing — the boot this pane is waiting for, reached through
         *     a re-mount. React's StrictMode does exactly that in development, so
         *     treating every reattach as unsafe would mean the prompt never worked
         *     while developing this feature.)
         *
         * Latched, because `ready` can fire more than once for one terminal and
         * output certainly can.
         */
        let initialInputSent = false;
        let promptTimer: ReturnType<typeof setTimeout> | undefined;
        // Nothing may be typed before `ready` has been SEEN, because `ready` is
        // what carries `resumed` — the answer to "is this agent already running".
        // Output can beat it here (it is the server's ordering, not ours, and the
        // server does work between opening the shell and announcing it), and
        // typing on first output alone would type into an agent whose state we had
        // not yet been told.
        let readySeen = false;
        /** Has the agent drawn anything? Proof it is up and reading its stdin. */
        let outputSeen = false;
        /** A re-bind's `ready` (see `handleSocketConnect` below) replies with the
         * session's FULL scrollback, and this terminal already displays everything
         * from before the drop — writing the replay on top would duplicate it.
         * Repaint instead: reset the buffer (the Terminal instance and its DOM
         * stay) and let the replay redraw, which also delivers output produced
         * while the socket was down. Cleared on the first `ready` after a re-bind
         * so a later duplicate `ready` cannot wipe live output. */
        let repaintOnReady = false;

        /** Spends the prompt without writing it — for a session that is past
         * taking one. The caller drops it either way, so it can never come back. */
        const discardInitialInput = () => {
          if (initialInputSent) return;
          initialInputSent = true;
          clearTimeout(promptTimer);
          initialInputRef.current.onSent?.();
        };

        const sendInitialInput = () => {
          const { input, onSent } = initialInputRef.current;
          if (!input || initialInputSent || !readySeen) return;
          // A disconnected socket BUFFERS this emit and flushes it on reconnect,
          // carrying a connectionId the server no longer knows — so it is dropped
          // there, while `onSent` here would already have spent the prompt. Keep it
          // unspent instead: whether a later connect may deliver it is decided by
          // that connect's own `resumed`, which is the only safe judge. The armed
          // backstop is disarmed too, so a re-bind's `ready` can arm it afresh
          // (its `promptTimer === undefined` re-arm check would otherwise see the
          // spent handle and never schedule another).
          if (socket.connected === false) {
            clearTimeout(promptTimer);
            promptTimer = undefined;
            return;
          }
          initialInputSent = true;
          clearTimeout(promptTimer);
          for (const chunk of toPtyInput(input)) {
            socket.emit('agent-terminal:input', { data: chunk, connectionId });
          }
          // Only now is the prompt spent — the caller drops it, so a later
          // re-mount reattaches instead of typing it at a running agent again.
          onSent?.();
        };

        const handleOutput = (payload: { data: string; connectionId?: string }) => {
          if (!isMine(payload)) return;
          terminal.write(payload.data);
          outputSeen = true;
          // The agent is alive and drawing; it can take its prompt — but only once
          // `ready` has told us WHICH agent this is (see `readySeen`).
          sendInitialInput();
        };
        const handleReady = (payload: { scrollback?: string; resumed?: boolean; connectionId?: string } = {}) => {
          if (!isMine(payload)) return;
          readySeen = true;
          if (repaintOnReady) {
            repaintOnReady = false;
            terminal.reset();
          }
          if (payload.scrollback) terminal.write(payload.scrollback);
          useEditingStore.getState().startEditing(sessionId, 'other', { componentName: 'agent-terminal' });

          // Already running (see above): the prompt is spent, never written.
          const alreadyRunning = payload.resumed === true || Boolean(payload.scrollback);
          if (alreadyRunning) {
            discardInitialInput();
          } else if (outputSeen) {
            // It was already drawing before this arrived: it is up, and now we know
            // it is a fresh boot. No reason to make the user wait out the backstop.
            sendInitialInput();
          } else if (initialInputRef.current.input && !initialInputSent && promptTimer === undefined) {
            promptTimer = setTimeout(sendInitialInput, PROMPT_BACKSTOP_MS);
          }
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

        /**
         * The PTY binding is per TRANSPORT CONNECTION, not per socket object:
         * socket.io reuses this same Socket across a transport reconnect, so this
         * effect (keyed [socket, sessionId]) never re-runs for one — but the
         * server side of the binding died with the transport (each server socket
         * holds its own connection registry and tears every pane down on
         * disconnect), leaving a pane that looks alive while its PTY drifts
         * toward the server's detached-idle reap. So the bind is re-emitted on
         * every `connect`. The server treats a connect for a scope whose session
         * is still live as a reattach (`attachToLiveSession` in
         * agent-terminal-handler.ts), so re-binding is idempotent: same
         * connectionId (the new server socket has a fresh registry, so it cannot
         * collide), same client listeners, no new PTY.
         */
        let bound = false;
        const bindPty = () => {
          socket.emit('agent-terminal:connect', { ...connectPayload, connectionId, cols: terminal.cols, rows: terminal.rows });
        };
        const handleSocketConnect = () => {
          // `connect` also fires for the INITIAL connection when this pane
          // mounted while the socket was still down — only a bind AFTER a
          // previous bind is a re-bind whose `ready` must repaint.
          repaintOnReady = bound;
          bound = true;
          bindPty();
        };
        const handleSocketDisconnect = () => {
          // Nothing is torn down here — the terminal, its buffer and every
          // listener stay, waiting for the re-bind. Just tell the user their
          // pane went quiet for a reason.
          if (!bound) return;
          terminal.writeln('\r\n\x1b[90mConnection lost — reconnecting…\x1b[0m');
        };

        // Register listeners BEFORE emitting agent-terminal:connect so we don't
        // miss early agent-terminal:ready / agent-terminal:output events.
        socket.on('agent-terminal:output', handleOutput);
        socket.on('agent-terminal:ready', handleReady);
        socket.on('agent-terminal:closed', handleClosed);
        socket.on('agent-terminal:error', handleError);
        socket.on('connect', handleSocketConnect);
        socket.on('disconnect', handleSocketDisconnect);

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
          // The pending write is cancelled, but the prompt is NOT spent: this pane
          // may be going away only for a moment (StrictMode remounts it in
          // development; a workspace switch remounts it later), and the agent it
          // was meant for may still be booting. Whether the next connect may
          // deliver it is decided there, from `resumed`/`scrollback` — not guessed
          // here.
          clearTimeout(promptTimer);
          onData.dispose();
          socket.off('agent-terminal:output', handleOutput);
          socket.off('agent-terminal:ready', handleReady);
          socket.off('agent-terminal:closed', handleClosed);
          socket.off('agent-terminal:error', handleError);
          socket.off('connect', handleSocketConnect);
          socket.off('disconnect', handleSocketDisconnect);
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

        // The tracking row for this scope must already exist — a pane's agent
        // picker (or the tab's add-terminal dialog) reserves it via
        // spawnAgentTerminal before the pane is ever bound to it, so connecting
        // here only ever attaches to (or resumes) an already-known session.
        //
        // Bind now if the socket is up; otherwise the `connect` handler above
        // does the first bind when it comes up. (Emitting while down would only
        // sit in socket.io's send buffer and flush as a DUPLICATE of that bind.)
        if (socket.connected) {
          bound = true;
          bindPty();
        }

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
