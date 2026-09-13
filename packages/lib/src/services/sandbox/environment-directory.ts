/**
 * The environment DIRECTORY — what `list_environments` answers (leaf B), built
 * as a pure function so the wording and the shape are testable without IO.
 *
 * **This exists so the model never has to invent an id.** In July an OPTIONAL
 * free-text `target` was added to the code-execution tools and removed two days
 * later (`cf576fbc1`): the model habitually supplied a plausible invented value
 * (`branch: "main"`) and every call was refused. The fix is not to drop
 * addressing but to make the value one a model CANNOT invent — an opaque id
 * copied from this list, where a guess simply does not exist and fails closed.
 * The wording below is therefore part of the mechanism, not documentation
 * around it: every answer tells the model to copy an id and never to construct
 * one.
 *
 * **Two substrates, two ways in.** A CLOUD environment is listed when the
 * person can already run code in its drive — the drive permission is the whole
 * of it, with nothing to opt in to, because a cloud env has no owner to opt in.
 * A LOCAL machine is listed when its owner has switched it on. The rows look
 * identical to the model on purpose: it addresses by id either way.
 *
 * **The conversation's own sandbox is a row like any other.** It is listed
 * first, addressed by the conversation's own id, and named plainly — so there
 * is no implicit path a model can take while believing it is somewhere else.
 * The conversation id is the address the runtime already resolves a session
 * through, it always exists, and a model cannot invent someone else's.
 *
 * **An empty list is never returned as an empty list.** A model handed `[]`
 * with a mandatory id to fill has every incentive to make one up, so the answer
 * says in words that there is nothing to copy.
 */

import { z } from 'zod';
import { isCuid } from '@paralleldrive/cuid2';

/**
 * What a badly-SHAPED environment id is told. Same instruction as every other
 * refusal: copy an id, never construct one.
 */
export const ENVIRONMENT_ID_SHAPE_MESSAGE =
  'environmentId must be an id copied from list_environments, not a name, a path, a branch or any other description. Call list_environments and copy an id from its output exactly.';

/**
 * An environment ADDRESS at the zod boundary (leaf C).
 *
 * Constrained to the opaque id SHAPE rather than accepting free text, because
 * free text is exactly what July's removed `target` accepted and exactly what
 * the model filled with a plausible invention (`branch: "main"`). Every id this
 * system can legitimately produce is a cuid2 — a `drive_envs.id` or a
 * conversation id — so anything else is refused before a lookup, and the
 * message says what to do instead.
 *
 * **The length floor is the load-bearing half.** `isCuid` is a loose
 * heuristic — it accepts any lowercase alphanumeric string of 2 to 32
 * characters — so on its own it would accept `main`, `staging` and `prod`,
 * which are precisely the values July's post-mortem saw the model invent.
 * Every id this system mints is a 24-character cuid2, so requiring at least
 * 20 characters rejects every plausible invention while accepting every real
 * id.
 *
 * The shape check is necessary and never sufficient: a well-shaped id that
 * names nothing the caller may reach is still refused, by `decideEnvReach`, and
 * with the SAME sentence.
 */
export const MIN_ENVIRONMENT_ID_LENGTH = 20;
export const MAX_ENVIRONMENT_ID_LENGTH = 32;

export const environmentIdSchema = z
  .string()
  .min(MIN_ENVIRONMENT_ID_LENGTH, ENVIRONMENT_ID_SHAPE_MESSAGE)
  .max(MAX_ENVIRONMENT_ID_LENGTH, ENVIRONMENT_ID_SHAPE_MESSAGE)
  .refine(isCuid, { message: ENVIRONMENT_ID_SHAPE_MESSAGE });

/** One addressable environment as the model sees it. */
export interface EnvironmentListing {
  /**
   * The OPAQUE address — a `drive_envs.id`, or the conversation's own id for
   * its own sandbox. Copied, never constructed.
   */
  readonly id: string;
  /** What to call it when speaking to the person. A label, never an address. */
  readonly label: string;
  /** What runs it: `sprite` (PageSpace's cloud) or `local` (the person's own machine). */
  readonly substrate: 'sprite' | 'local';
  /** The drive that owns it; `null` for a global-assistant conversation's own sandbox, which belongs to no drive. */
  readonly driveId: string | null;
  /** `conversation` = this conversation's own sandbox; `environment` = a persistent environment named by its owner. */
  readonly kind: 'conversation' | 'environment';
}

export interface EnvironmentDirectory {
  readonly environments: readonly EnvironmentListing[];
  /** Said in words, always — see the module doc on why an empty list is not an answer. */
  readonly notice: string;
}

/** The sentence every directory ends with. The anti-invention instruction, in one place. */
export const COPY_THE_ID_NOTICE =
  'Pass one of these ids verbatim as environmentId on bash, writeFile, readFile and editFile. Copy it exactly from this list — never construct, shorten or guess an id, and never reuse an id from an earlier conversation.';

/**
 * What the caller is told when nothing but their own sandbox is reachable.
 *
 * It names BOTH reasons, because the two substrates become reachable in
 * different ways and a person reading it back needs to know which lever is
 * theirs: a cloud environment appears when they can run code in its drive
 * (nothing to switch on), a local machine when its owner switches it on.
 */
export const NO_VISIBLE_ENVIRONMENTS_NOTICE =
  "You have no other environments available: there is no cloud environment in a drive you can run code in, and no computer of your own switched on for your assistant. The only place you can run anything is this conversation's own sandbox, listed above.";

export interface EnvironmentDirectoryInput {
  /** This conversation's own sandbox — always present, always first. */
  readonly conversation: { readonly id: string; readonly driveId: string | null };
  /** The persistent environments the caller may reach, already filtered for access AND visibility by the store. */
  readonly environments: readonly {
    readonly id: string;
    readonly label: string;
    readonly substrate: 'sprite' | 'local';
    readonly driveId: string;
  }[];
}

/** The conversation's own sandbox, named so a model reads it as a place rather than a fallback. */
export const OWN_SANDBOX_LABEL = "This conversation's own sandbox";

export function buildEnvironmentDirectory(input: EnvironmentDirectoryInput): EnvironmentDirectory {
  const own: EnvironmentListing = {
    id: input.conversation.id,
    label: OWN_SANDBOX_LABEL,
    substrate: 'sprite',
    driveId: input.conversation.driveId,
    kind: 'conversation',
  };
  const named: EnvironmentListing[] = input.environments.map((env) => ({
    id: env.id,
    label: env.label,
    substrate: env.substrate,
    driveId: env.driveId,
    kind: 'environment',
  }));
  const notice = named.length === 0 ? `${NO_VISIBLE_ENVIRONMENTS_NOTICE} ${COPY_THE_ID_NOTICE}` : COPY_THE_ID_NOTICE;
  return { environments: [own, ...named], notice };
}
