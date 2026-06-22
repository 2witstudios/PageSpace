import type { SpriteInstanceLike } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';

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
  const cmd = sprite.spawn('bash', [], { tty: true, cols, rows });

  cmd.stdout.on('data', (chunk) => onOutput(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
  cmd.stderr.on('data', (chunk) => onOutput(typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
  cmd.on('exit', (code) => onExit(code));

  return {
    write: (data) => cmd.stdin!.write(data),
    resize: (c, r) => cmd.resize?.(c, r),
    kill: () => cmd.kill('SIGKILL'),
  };
}
