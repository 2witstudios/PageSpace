/**
 * May the GLOBAL ASSISTANT reach this environment? (leaf A / leaf C)
 *
 * The global assistant is the one agent whose context spans every drive a
 * person belongs to, so what it may reach is a deliberate choice rather than a
 * consequence of ownership. This is that choice, evaluated as a pure function
 * so that every caller asks it the same way and no call site can answer it
 * with a habit.
 *
 * **Every refusal, ONE sentence.** `not_global`, `not_found`, `not_owner` and
 * `not_visible` are separate typed reasons so the server can audit which one
 * fired, but the message a model (and therefore a user of the model) sees is
 * identical for all of them — `ENV_UNREACHABLE_MESSAGE`. An addressing failure must not tell
 * the caller whether the id they guessed exists, who owns it, or whether it is
 * merely switched off: any of those is a probe. The tests pin the three to one
 * string.
 *
 * **Absence is never a grant.** A missing row, a missing owner and a `false`
 * flag all refuse. There is no "unset" that means yes.
 *
 * **Four refusals, one sentence.** `not_global` joins them for the same reason:
 * a page conversation must not be able to tell a real environment id from a
 * made-up one either.
 *
 * **Two substrates, two authorities, one function.** A CLOUD (Sprite) env is
 * drive-owned and has no owner of its own, so its authority is the DRIVE
 * PERMISSION the person already holds — `canRunCode` for that drive, injected
 * as `mayRunCodeInEnvDrive`. The founder's ruling is exact parity: *if the user
 * can, their global assistant should be able to*. There is no per-env opt-in
 * for a cloud env because there is nobody to give one. A LOCAL machine is one
 * person's computer, so its authority is that person plus their explicit
 * opt-in, and neither half is substitutable by a drive permission.
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
  /**
   * What runs this environment. It is the DISCRIMINATOR for how reach is
   * decided, because the two substrates answer to different authorities:
   *
   *  - `'sprite'` — a CLOUD environment. Drive-owned, drive-paid, drive-shared,
   *    with no owner of its own. Its authority is the DRIVE PERMISSION the
   *    person already has, so there is nothing to opt in to.
   *  - `'local'` — one person's own computer. Its authority is that person
   *    ([D-6]), plus their explicit opt-in.
   */
  readonly substrate: 'sprite' | 'local';
  /**
   * `drive_envs.visibleToGlobalAssistant`. A LOCAL-machine opt-in only: the
   * owner deciding whether their own computer is in reach. Default false on the
   * column, and absence is never a grant.
   *
   * **Deliberately not consulted for a cloud env**, in either direction — see
   * the module doc. A cloud env has no owner to set it, so treating it as a
   * gate would make every cloud env permanently unreachable, and treating a
   * stray `true` as a grant would let a row widen what the drive decided.
   */
  readonly visibleToGlobalAssistant: boolean;
  /**
   * The environment's OWNER — `drive_env_local.ownerId` for a local machine.
   * `null` for a Sprite env (which has none by design) or a local env whose
   * owner was erased. Only consulted on the local arm.
   */
  readonly ownerId: string | null;
}

/**
 * Which KIND of conversation is asking. Only `'global'` may reach a persistent
 * environment; everything else — a page agent's conversation, or an unknown
 * surface — is `'page'` and fails closed.
 */
export type ConversationKind = 'global' | 'page';

/**
 * May a conversation of this kind reach a PERSISTENT environment at all?
 *
 * **The promise the product makes is specifically about the GLOBAL assistant.**
 * The column is `visibleToGlobalAssistant`, the settings toggle says "Let your
 * global assistant use this machine", and the changelog says the same. A page
 * agent in a drive is a different agent with a different audience, and a person
 * who switched their laptop on for the assistant they talk to from the
 * dashboard did not thereby switch it on for every sandbox-enabled agent in
 * every drive they belong to.
 *
 * This has to be a fact the DECISION owns rather than a check at one call site,
 * because there are two call sites — discovery and resolution — and the tool
 * registry is built ONCE per process and shared by every turn
 * (`ai-tools.ts`), so nothing about the tool objects themselves distinguishes a
 * dashboard turn from a page turn.
 */
export function conversationMayReachPersistentEnvironments(kind: ConversationKind): boolean {
  return kind === 'global';
}

export type EnvReachDenyReason = 'not_global' | 'not_found' | 'not_permitted' | 'not_owner' | 'not_visible';

export type EnvReachVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: EnvReachDenyReason };

/** The documented, tested deny order. */
export const ENV_REACH_DENY_ORDER: readonly EnvReachDenyReason[] = ['not_global', 'not_found', 'not_permitted', 'not_owner', 'not_visible'];

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
export function decideEnvReach(input: {
  actorId: string;
  /** Which kind of conversation is asking. Only a global one may reach a persistent environment. */
  conversationKind: ConversationKind;
  /**
   * `canRunCode({ userId, driveId: env.driveId })` for the acting user, computed
   * by the caller and injected so this stays pure.
   *
   * It is the WHOLE authority for a cloud env, deliberately: the same kill
   * switch, the same payer tier, the same drive access and `canEdit` bar the
   * person meets to run code in that drive from any other surface. Re-deriving
   * any part of it here would be a second answer to a question `canRunCode`
   * already owns, and the drift guard in the test suite exists to keep the two
   * from ever disagreeing.
   */
  mayRunCodeInEnvDrive: boolean;
  env: EnvReachFacts | null;
}): EnvReachVerdict {
  // FIRST, and before the row is even consulted: a page conversation may not
  // reach a persistent environment whatever the row says, so it must not be
  // able to learn anything about one from the order of these checks either.
  if (!conversationMayReachPersistentEnvironments(input.conversationKind)) return { ok: false, reason: 'not_global' };
  if (input.env === null) return { ok: false, reason: 'not_found' };

  // A CLOUD env: the drive permission IS the visibility. "If the user can,
  // their global assistant should be able to" — exact parity, nothing more and
  // nothing less. No owner is consulted (there is none) and no opt-in is
  // consulted (there is nobody to give one).
  if (input.env.substrate === 'sprite') {
    return input.mayRunCodeInEnvDrive ? { ok: true } : { ok: false, reason: 'not_permitted' };
  }

  // A LOCAL machine: unchanged. The owner, and then the owner's explicit
  // opt-in. Permission to run code in the drive the machine happens to be
  // enrolled in is NOT a substitute for either ([D-6]).
  if (input.env.ownerId === null || input.env.ownerId !== input.actorId) return { ok: false, reason: 'not_owner' };
  if (!input.env.visibleToGlobalAssistant) return { ok: false, reason: 'not_visible' };
  return { ok: true };
}
