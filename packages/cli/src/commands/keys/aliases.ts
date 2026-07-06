/**
 * `pagespace keys list`/`pagespace keys revoke` (Phase 9 task 5) — flag-based,
 * scriptable aliases over the exact same logic `tokens list`/`tokens revoke`
 * already run (`tokensList`/`tokensRevoke`, extracted for this purpose).
 *
 * Wrapped in a NEW arrow function (not re-exported as the same reference)
 * deliberately: `run.ts`'s `AUTH_EXEMPT_HANDLERS` gates by `CommandHandler`
 * identity, and these `keys` routes must be ambient-credential-eligible
 * (a bare `pagespace login` can drive them with zero extra setup) while
 * `tokens list`/`tokens revoke` stay explicit-credential-only — see this
 * package's `keys` vs `tokens` design note in `router/routes.ts`. Reusing
 * `tokensListHandler`/`tokensRevokeHandler` directly would exempt both
 * surfaces at once, which is not the design this phase asked for.
 *
 * `keys create` has no equivalent wrapper: `tokensCreateHandler` is already
 * auth-exempt, so both `tokens create` and `keys create` register that exact
 * same handler reference (see `router/routes.ts`).
 */
import type { CommandHandler } from '../../router/router.js';
import { tokensList } from '../tokens/list.js';
import { tokensRevoke } from '../tokens/revoke.js';

export const keysListHandler: CommandHandler = (ctx, intent) => tokensList(ctx, intent);
export const keysRevokeHandler: CommandHandler = (ctx, intent) => tokensRevoke(ctx, intent);
