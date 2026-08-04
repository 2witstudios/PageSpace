/**
 * Router — resolves a parsed `CommandIntent.args` path against a static route
 * table. Longest-prefix match so a route like `['keys']` and a more
 * specific `['keys', 'create']` can coexist; unmatched args are a typed
 * usage error, never a thrown exception.
 */
import type { CommandIntent } from '../argv/parse.js';
import type { ExitCode } from '../exit-codes.js';
import type { HandlerContext } from '../handler-context.js';

export type CommandHandler = (ctx: HandlerContext, intent: CommandIntent) => Promise<ExitCode>;

export interface Route {
  readonly path: readonly string[];
  readonly handler: CommandHandler;
  /**
   * The handler resolves while its real work keeps running on live handles
   * (e.g. `mcp`'s stdio server on stdin) — `bin.ts` must NOT force-exit the
   * process after `run()` settles for such a route. Declared here, on the
   * route table (the single source of truth for the command tree), so a
   * future long-running command can't forget to opt out of the force-exit.
   */
  readonly longRunning?: true;
  /**
   * The handler serves a protocol whose client can only observe a startup
   * failure as a silent hang (e.g. `mcp`'s stdio server — a child that exits
   * before the transport connects looks identical to a hung server from the
   * far side of the pipe). `run.ts` must NOT materialize auth (keychain read,
   * OAuth discovery/refresh) before dispatching such a route: it defers all
   * credential resolution to the first actual use, where a failure surfaces
   * through the protocol as an actionable error instead of a dead process.
   */
  readonly lazyAuth?: true;
}

export type RouteResolution =
  | { readonly kind: 'match'; readonly route: Route; readonly rest: readonly string[] }
  | { readonly kind: 'usage-error'; readonly message: string };

export function resolveRoute(routes: readonly Route[], args: readonly string[]): RouteResolution {
  if (args.length === 0) {
    return { kind: 'usage-error', message: 'No command given. Run "pagespace help" to see available commands.' };
  }

  const byLongestPathFirst = [...routes].sort((a, b) => b.path.length - a.path.length);
  for (const route of byLongestPathFirst) {
    if (route.path.length > 0 && route.path.length <= args.length && route.path.every((segment, i) => segment === args[i])) {
      return { kind: 'match', route, rest: args.slice(route.path.length) };
    }
  }

  return { kind: 'usage-error', message: `Unknown command: ${args.join(' ')}` };
}
