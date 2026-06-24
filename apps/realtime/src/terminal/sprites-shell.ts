import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { SANDBOX_ROOT } from '@pagespace/lib/services/sandbox/sandbox-paths';

export type PtyShell = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type OpenPtyShellArgs = {
  sprite: SpriteInstanceLike;
  cols: number;
  rows: number;
  onOutput(data: string): void;
  onExit(exitCode: number): void;
};

export function openPtyShell({ sprite, cols, rows, onOutput, onExit }: OpenPtyShellArgs): PtyShell {
  const cmd = sprite.spawn('bash', [], {
    tty: true,
    cols,
    rows,
    cwd: SANDBOX_ROOT,
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' },
  });

  const toStr = (chunk: unknown) => (typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
  cmd.stdout.on('data', (chunk) => onOutput(toStr(chunk)));
  cmd.stderr.on('data', (chunk) => onOutput(toStr(chunk)));
  cmd.on('error', (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    onOutput(`\r\n\x1b[31mShell error: ${msg}\x1b[0m\r\n`);
    onExit(-1);
  });
  cmd.on('exit', (code) => onExit(code ?? -1));

  return {
    write: (data) => { cmd.stdin?.write(data); },
    resize: (c, r) => cmd.resize?.(c, r),
    kill: () => cmd.kill('SIGKILL'),
  };
}
