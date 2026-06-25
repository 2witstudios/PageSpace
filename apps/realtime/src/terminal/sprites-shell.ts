import type {
  SpriteInstanceLike,
  SpriteCommandLike,
  SpriteSessionInfo,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';

/**
 * Pick the live interactive shell to reattach to from a Sprite's exec sessions.
 * A terminal owns exactly one TTY shell per Sprite (one page = one Sprite), so
 * match on `tty` rather than on `isActive` — the API's `is_active` semantics
 * (process-alive vs client-attached) are undocumented, and a detached-but-running
 * shell may report `is_active: false`. `isActive` is used only as a tiebreaker.
 */
export function pickShellSession(sessions: SpriteSessionInfo[]): SpriteSessionInfo | undefined {
  const shells = sessions.filter((s) => s.tty);
  return shells.find((s) => s.isActive) ?? shells[0];
}

export type PtyShell = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type OpenPtyShellArgs = {
  sprite: SpriteInstanceLike;
  cols: number;
  rows: number;
  /**
   * When set, attach to this existing detachable session instead of creating a
   * fresh shell — used to reattach to a shell that survived a navigation away or
   * a realtime-process restart, replaying its scrollback.
   */
  sessionId?: string;
  onOutput(data: string): void;
  onExit(exitCode: number): void;
};

// The @fly/sprites WSCommand keepalive is output-driven: it declares the socket
// dead after 45s with no INBOUND frame (see websocket.js WS_PONG_WAIT), even
// though the shell is still alive server-side — a TTY session has
// max_run_after_disconnect:0, so it keeps running after the client drops, and
// the docs specify no server ping / idle timeout. An idle prompt therefore trips
// the CLIENT watchdog on a fixed cadence. We treat that (and any mid-session WS
// drop) as a transient disconnect and transparently reattach to the live session
// rather than tearing the terminal down. Consecutive FAILED reattaches are
// bounded so a genuinely dead Sprite still surfaces an exit.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 200;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const TERMINAL_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' };

export function openPtyShell({ sprite, cols, rows, sessionId, onOutput, onExit }: OpenPtyShellArgs): PtyShell {
  const toStr = (chunk: unknown) => (typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));

  let current: SpriteCommandLike;
  // The live tmux session id to reattach to. Known immediately when attaching;
  // for a freshly created session it is resolved in the background via
  // listSessions() (and again at reconnect time as a fallback).
  let currentSessionId: string | undefined = sessionId;
  let lastCols = cols;
  let lastRows = rows;
  let closed = false; // a real exit (or exhausted reconnects) — stop everything
  let reconnecting = false;
  let consecutiveFailures = 0;

  function fatal(exitCode: number, message?: string): void {
    if (closed) return;
    closed = true;
    if (message !== undefined) onOutput(`\r\n\x1b[31mShell error: ${message}\x1b[0m\r\n`);
    onExit(exitCode);
  }

  function wire(cmd: SpriteCommandLike): void {
    cmd.stdout.on('data', (chunk) => {
      // Any inbound data proves the connection recovered; reset the failure budget.
      consecutiveFailures = 0;
      onOutput(toStr(chunk));
    });
    cmd.stderr.on('data', (chunk) => onOutput(toStr(chunk)));
    cmd.on('exit', (code) => fatal(code ?? -1));
    cmd.on('error', () => { void reconnect(); });
  }

  async function reconnect(): Promise<void> {
    if (closed || reconnecting) return;
    reconnecting = true;
    consecutiveFailures += 1;
    if (consecutiveFailures > MAX_RECONNECT_ATTEMPTS) {
      reconnecting = false;
      fatal(-1, 'lost connection to shell');
      return;
    }
    try {
      await delay(RECONNECT_BASE_DELAY_MS * consecutiveFailures);
      if (closed) { reconnecting = false; return; }

      let id = currentSessionId;
      if (id === undefined) {
        id = pickShellSession(await sprite.listSessions())?.id;
      }
      if (id === undefined) {
        // No live session to reattach to — the shell is genuinely gone.
        reconnecting = false;
        fatal(-1);
        return;
      }
      currentSessionId = id;
      current = sprite.attachSession(id, { cols: lastCols, rows: lastRows });
      wire(current);
      reconnecting = false;
    } catch {
      reconnecting = false;
      // Reattach itself failed; retry until the bounded budget is exhausted.
      void reconnect();
    }
  }

  if (currentSessionId !== undefined) {
    current = sprite.attachSession(currentSessionId, { cols, rows });
  } else {
    current = sprite.createSession('bash', [], {
      tty: true,
      cols,
      rows,
      cwd: SANDBOX_ROOT,
      env: TERMINAL_ENV,
    });
    // Resolve our own session id so a keepalive drop can reattach to it. Best
    // effort: reconnect() also resolves it on demand if this hasn't landed yet.
    void sprite
      .listSessions()
      .then((sessions) => {
        if (currentSessionId === undefined) {
          currentSessionId = pickShellSession(sessions)?.id;
        }
      })
      .catch(() => {});
  }
  wire(current);

  return {
    write: (data) => { if (!closed) current.stdin?.write(data); },
    resize: (c, r) => { lastCols = c; lastRows = r; if (!closed) current.resize?.(c, r); },
    kill: () => { closed = true; current.kill('SIGKILL'); },
  };
}
