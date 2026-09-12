/**
 * May the GLOBAL ASSISTANT reach this environment? (leaf A / leaf C)
 *
 * The global assistant is the one agent whose context spans every drive a
 * person belongs to, so what it may reach is a deliberate choice rather than a
 * consequence of ownership. This is that choice, evaluated as a pure function
 * so that every caller asks it the same way and no call site can answer it
 * with a habit.
 *
 * **Three refusals, ONE sentence.** `not_found`, `not_owner` and `not_visible`
 * are separate typed reasons so the server can audit which one fired, but the
 * message a model (and therefore a user of the model) sees is identical for
 * all three — `ENV_UNREACHABLE_MESSAGE`. An addressing failure must not tell
 * the caller whether the id they guessed exists, who owns it, or whether it is
 * merely switched off: any of those is a probe. The tests pin the three to one
 * string.
 *
 * **Absence is never a grant.** A missing row, a missing owner and a `false`
 * flag all refuse. There is no "unset" that means yes.
 *
 * **Visibility is not authority.** An `ok` here says only that the assistant
 * may ADDRESS this environment. Whether anything may then run on it is still
 * `decideBind` / `decideSign` / the machine's own policy, unchanged — for a
 * local environment, binding remains the enrolling owner's alone ([D-6]).
 * This function must never be read as a bind decision, and it deliberately
 * refuses a non-owner rather than deferring, so it can never be the widest
 * check in the chain.
 *
 * **It is asked on EVERY call, not once at bind.** That is what makes turning
 * visibility off take effect immediately: a conversation already holding a
 * session in an environment is refused its next call rather than riding an
 * earlier reach.
 *
 * Pure: no db, no clock, no IO.
 */

/** What the reach decision needs to know about an environment. `null` = no such row. */
export interface EnvReachFacts {
  /** `drive_envs.visibleToGlobalAssistant`. Default false on the column; absence is never a grant. */
  readonly visibleToGlobalAssistant: boolean;
  /**
   * The environment's OWNER — `drive_env_local.ownerId` for a local machine.
   * `null` for an environment with no owner (a Sprite env, or a local env
   * whose owner was erased): nobody can be the owner of an ownerless
   * environment, so every actor is refused.
   */
  readonly ownerId: string | null;
}

export type EnvReachDenyReason = 'not_found' | 'not_owner' | 'not_visible';

export type EnvReachVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: EnvReachDenyReason };

/** The documented, tested deny order. */
export const ENV_REACH_DENY_ORDER: readonly EnvReachDenyReason[] = ['not_found', 'not_owner', 'not_visible'];

/**
 * The ONE sentence every reach refusal surfaces, whatever the typed reason.
 *
 * It names the discovery tool and tells the model not to construct an id,
 * because July's post-mortem (`cf576fbc1`) records that the prompt and the
 * tool descriptions actively encouraged an invented value — so the wording is
 * part of the fix, not documentation around it.
 */
export const ENV_UNREACHABLE_MESSAGE =
  'No environment with that id is available to you. Call list_environments and copy an id from its output exactly — never construct or guess one.';

/** @returns `ok`, or the first reason in `ENV_REACH_DENY_ORDER` that applies. */
export function decideEnvReach(input: { actorId: string; env: EnvReachFacts | null }): EnvReachVerdict {
  if (input.env === null) return { ok: false, reason: 'not_found' };
  if (input.env.ownerId === null || input.env.ownerId !== input.actorId) return { ok: false, reason: 'not_owner' };
  if (!input.env.visibleToGlobalAssistant) return { ok: false, reason: 'not_visible' };
  return { ok: true };
}
