/**
 * `pagespace-mcp` bin — a first-class, zero-install entry point for running
 * the same `pagespace mcp` stdio server via `npx -y @pagespace/cli
 * pagespace-mcp`. `run.ts` already resolves `PAGESPACE_API_URL`/
 * `PAGESPACE_AUTH_TOKEN` (`auth/legacy-token-env.ts`) for every command, so
 * this alias needs no auth logic of its own — it just has to route to `mcp`.
 * Kept as a pure composition over injected `RunDependencies` (same shape
 * `run.ts` takes) so it's unit-testable without a real process; `bin.ts`'s
 * "only file allowed to touch `process.*`" rule has its own equivalent here
 * in `bin-pagespace-mcp.ts`.
 */
import { run, type RunDependencies } from './run.js';
import type { ExitCode } from './exit-codes.js';

export function buildPagespaceMcpArgv(argv: readonly string[]): string[] {
  return ['mcp', ...argv];
}

export async function runPagespaceMcpBin(deps: RunDependencies): Promise<ExitCode> {
  return run({ ...deps, argv: buildPagespaceMcpArgv(deps.argv) });
}
