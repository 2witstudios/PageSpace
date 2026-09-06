/**
 * Lazy entry points for the daemon commands. `env connect` / `env policy`
 * are the first CLI commands that runtime-import `@pagespace/lib` (its
 * env-bridge pure core — the decisions are deliberately NOT re-implemented
 * here; see the epic's Agent Contract). Every other command has kept the
 * published package free of that import, so these three are loaded on
 * demand: a `pagespace` install without the library still runs every other
 * command, and only the daemon commands fail, at invocation, with the
 * loader's own message. `run.ts` and `routes.ts` reference THESE handlers.
 */
import type { CommandHandler } from '../../router/router.js';

export const envConnectHandler: CommandHandler = async (ctx, intent) => (await import('./connect.js')).envConnectHandler(ctx, intent);
export const envDisconnectHandler: CommandHandler = async (ctx, intent) => (await import('./disconnect.js')).envDisconnectHandler(ctx, intent);
export const envPolicyHandler: CommandHandler = async (ctx, intent) => (await import('./policy.js')).envPolicyHandler(ctx, intent);
