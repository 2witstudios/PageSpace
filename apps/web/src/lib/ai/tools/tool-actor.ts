import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import type { ToolExecutionContext } from '../core/types';

/**
 * The access actor this tool call runs as (D-OW-45): the credential that drove the turn, or the automation that
 * runs as its creator. Its user must be the context's user; a context that disagrees with itself refuses, never
 * guesses.
 *
 * Kept free of runtime imports: the sandbox tool modules import it, and their tool-name catalogs are also imported
 * by client code (core/tool-filtering), so anything this module imports ships to the browser.
 */
export function toolActor(context: ToolExecutionContext): AccessActor {
  if (context.accessActor.userId !== context.userId) {
    throw new Error('Tool context actor does not match its user');
  }
  return context.accessActor;
}
