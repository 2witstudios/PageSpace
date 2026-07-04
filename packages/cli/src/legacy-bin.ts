/**
 * `pagespace-mcp` bin alias (Phase 6 task 3) — zero-config-change migration
 * for existing `npx pagespace-mcp` users. Forces the "mcp" route and forwards
 * every other input untouched: `run.ts` already resolves `PAGESPACE_API_URL`/
 * `PAGESPACE_AUTH_TOKEN` (`auth/legacy-token-env.ts`) for every command, so
 * this alias needs no auth logic of its own — it just has to route to `mcp`.
 * Kept as a pure composition over injected `RunDependencies` (same shape
 * `run.ts` takes) so it's unit-testable without a real process; `bin.ts`'s
 * "only file allowed to touch `process.*`" rule has its own equivalent here
 * in `bin-pagespace-mcp.ts`.
 */
import { run, type RunDependencies } from './run.js';
import type { ExitCode } from './exit-codes.js';

export const LEGACY_MCP_DEPRECATION_NOTICE =
  '"pagespace-mcp" is deprecated. Run "pagespace mcp" instead — see ' +
  'packages/cli/docs/migrating-from-pagespace-mcp.md for the migration guide.';

export function buildLegacyMcpArgv(argv: readonly string[]): string[] {
  return ['mcp', ...argv];
}

export async function runLegacyMcpBin(deps: RunDependencies): Promise<ExitCode> {
  deps.stderr.write(`${LEGACY_MCP_DEPRECATION_NOTICE}\n`);
  return run({ ...deps, argv: buildLegacyMcpArgv(deps.argv) });
}
