/**
 * `pagespace agents list|ask|config` and `pagespace models list` (Phase 5
 * task 5). Thin projections over the `agents.*` SDK operations (Phase 3 task
 * 5; already wired onto the client facade before this task) — this module
 * adds no SDK surface, only argv parsing and result rendering.
 *
 * `agents.ask`'s output has a flat `response: string` field, not an AI SDK
 * `parts` array (`operations/agents.ts`'s `askAgentOutputSchema`) — same
 * "route truth over an assumed shape" idiom `operations/channels.ts`
 * documents for channel messages. Human-mode rendering prints that string
 * directly; there is no non-text part to summarize.
 *
 * ASK IS ADDRESSED BEFORE IT IS SENT. The handler mints the conversation id
 * itself and passes it as `newConversationId`, rather than letting the route
 * mint one and report it in a response body that a timed-out caller never
 * receives. This is the whole recovery story: `agents.ask` is non-idempotent
 * and is never auto-retried, and the consult route does not read
 * `request.signal` — so a client-side timeout stops the WAITING, never the
 * work. The consult keeps running, bills, and persists its answer. Knowing
 * the address up front is what turns that from paid-for-and-lost into
 * `pagespace conversations read <agentId> <conversationId>`.
 *
 * The id matches the repository-wide id contract (`^[a-z][a-z0-9]{1,31}$` —
 * the shape `createId()` produces), which the consult route validates: a uuid
 * would simply be refused. See `mintConversationId` for why this does not pull
 * in the cuid2 package to produce it.
 *
 * The success path still prints the id the SERVER reports, not the minted one.
 * They agree against any server that understands `newConversationId`; against
 * an older one the field is ignored and the server's own id is the truth, so
 * echoing the local guess would print an address that does not exist.
 *
 * `agents config --set k=v` intentionally keeps no allowlist of valid keys:
 * it forwards whatever `--set` pairs the caller gives straight onto
 * `agents.updateConfig`'s input object. An unrecognized key either gets
 * stripped by that operation's zod schema before the network call, or — if
 * every `--set` key given is unrecognized — the route itself 400s ("no
 * updatable field"), which `callSdk` already surfaces verbatim. Either way
 * the schema/server is the one source of truth for valid keys, never a
 * second CLI-side list that could drift from it.
 */
import { randomBytes } from 'node:crypto';
import type { PageSpaceClient } from '@pagespace/sdk';
import { isTimeoutError } from '@pagespace/sdk';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from '../exit-codes.js';
import type { CommandHandler } from '../router/router.js';
import { extractDriveFlag } from './drive-flag.js';
import { callSdk } from './sdk-error.js';

type AgentsListResult = Awaited<ReturnType<PageSpaceClient['agents']['list']>>;
type AgentsMultiDriveListResult = Awaited<ReturnType<PageSpaceClient['agents']['listMultiDrive']>>;
type UpdateAgentConfigInput = Parameters<PageSpaceClient['agents']['updateConfig']>[0];
type ModelsListResult = Awaited<ReturnType<PageSpaceClient['agents']['listModels']>>;

// ---------------------------------------------------------------------------
// agents list -> agents.list / agents.listMultiDrive
// ---------------------------------------------------------------------------

/** Pure: no I/O. */
export function renderAgentsList(value: AgentsListResult): string {
  if (value.agents.length === 0) return 'No agents.\n';
  return `${value.agents.map((agent) => `${agent.id}  ${agent.title ?? '(untitled)'}  [${agent.aiProvider}/${agent.aiModel}]`).join('\n')}\n`;
}

/** Pure: no I/O. */
export function renderAgentsMultiDriveList(value: AgentsMultiDriveListResult): string {
  const agents = value.agents ?? value.agentsByDrive?.flatMap((entry) => entry.agents) ?? [];
  if (agents.length === 0) return 'No agents.\n';
  return `${agents.map((agent) => `${agent.driveSlug}:${agent.id}  ${agent.title ?? '(untitled)'}  [${agent.aiProvider}/${agent.aiModel}]`).join('\n')}\n`;
}

/** Pure: no I/O. Consumes a lone `--all-drives` boolean flag, passing everything else through in `rest`. */
function extractAllDrivesFlag(args: readonly string[]): { readonly allDrives: boolean; readonly rest: readonly string[] } {
  const rest: string[] = [];
  let allDrives = false;
  for (const token of args) {
    if (token === '--all-drives') {
      allDrives = true;
      continue;
    }
    rest.push(token);
  }
  return { allDrives, rest };
}

export const agentsListHandler: CommandHandler = async (ctx, intent) => {
  const usage = 'Usage: pagespace agents list --drive <driveId> | --all-drives [--json]\n';

  const driveExtracted = extractDriveFlag(intent.args);
  if (!driveExtracted.ok) {
    ctx.stderr.write(`${driveExtracted.message}\n`);
    return EXIT_USAGE_ERROR;
  }

  const { allDrives, rest } = extractAllDrivesFlag(driveExtracted.rest);
  if (rest.length > 0) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const driveId = driveExtracted.driveId;
  if (driveId !== undefined && allDrives) {
    ctx.stderr.write('Flags --drive and --all-drives are mutually exclusive.\n');
    return EXIT_USAGE_ERROR;
  }
  if (driveId === undefined && !allDrives) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  if (allDrives) {
    const result = await callSdk(ctx.stderr, () => ctx.sdk.agents.listMultiDrive({}));
    if (!result.ok) return EXIT_RUNTIME_ERROR;
    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
      return EXIT_SUCCESS;
    }
    ctx.stdout.write(renderAgentsMultiDriveList(result.value));
    return EXIT_SUCCESS;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.agents.list({ driveId: driveId as string }));
  if (!result.ok) return EXIT_RUNTIME_ERROR;
  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }
  ctx.stdout.write(renderAgentsList(result.value));
  return EXIT_SUCCESS;
};

// ---------------------------------------------------------------------------
// agents ask -> agents.ask
// ---------------------------------------------------------------------------

type FlagScanResult =
  | { readonly ok: true; readonly values: ReadonlyMap<string, string>; readonly rest: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** Pure: no I/O. Consumes any of `flags`' value-taking tokens, passing everything else through in `rest`. */
function scanValueFlags(args: readonly string[], flags: readonly string[]): FlagScanResult {
  const values = new Map<string, string>();
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i] as string;
    if (flags.includes(token)) {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, message: `Flag ${token} requires a value.` };
      values.set(token, value);
      i += 2;
      continue;
    }
    rest.push(token);
    i += 1;
  }
  return { ok: true, values, rest };
}

/**
 * Pure: no I/O. The stderr text for a consult whose deadline expired.
 *
 * States three things the previous message did not, each of which a caller
 * needs in order to act: that the work is probably still running rather than
 * failed, the exact command that retrieves the answer, and how to wait longer
 * next time. The old text ended at "check the agent's conversation history",
 * naming a capability the CLI did not have — advice that could not be
 * followed is worse than none, because it reads as though recovery were
 * routine.
 */
export function renderAskTimeoutMessage(agentId: string, conversationId: string): string {
  return [
    `Request to agent ${agentId} timed out — the CLI stopped waiting, but the consult almost certainly did not stop running.`,
    'It is never retried automatically: a consult is non-idempotent, and asking again would double-execute it (and bill twice).',
    '',
    'The answer is being written to:',
    `  pagespace conversations read ${agentId} ${conversationId}`,
    '',
    `If that conversation is not there yet, give it a moment; if it never appears, list what does exist with "pagespace conversations list ${agentId}".`,
    'To wait longer next time, pass --timeout <seconds> or set PAGESPACE_TIMEOUT_MS.',
  ].join('\n') + '\n';
}

export interface AgentsAskDeps {
  /** Injected so the minted conversation id is deterministic under test. */
  readonly newConversationId: () => string;
}

export function createAgentsAskHandler(deps: AgentsAskDeps): CommandHandler {
  return async (ctx, intent) => {
    const usage = 'Usage: pagespace agents ask <agentPageId> <message> [--conversation-id <id>] [--context <text>]\n';

    const scanned = scanValueFlags(intent.args, ['--conversation-id', '--context']);
    if (!scanned.ok) {
      ctx.stderr.write(`${scanned.message}\n`);
      return EXIT_USAGE_ERROR;
    }

    const [agentId, question, ...extra] = scanned.rest;
    if (!agentId || !question || extra.length > 0) {
      ctx.stderr.write(usage);
      return EXIT_USAGE_ERROR;
    }

    // Continuing an existing conversation and starting a new one are separate
    // fields on the operation, and passing both is a 400 — so mint an address
    // only when the caller did not name one.
    const continuing = scanned.values.get('--conversation-id');
    const minted = continuing === undefined ? deps.newConversationId() : undefined;

    let result: Awaited<ReturnType<PageSpaceClient['agents']['ask']>>;
    try {
      result = await ctx.sdk.agents.ask({
        agentId,
        question,
        context: scanned.values.get('--context'),
        conversationId: continuing,
        newConversationId: minted,
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        // `continuing ?? minted` — exactly one is defined, and the address is
        // known either way, which is the point of minting it before sending.
        ctx.stderr.write(renderAskTimeoutMessage(agentId, (continuing ?? minted) as string));
        return EXIT_RUNTIME_ERROR;
      }
      ctx.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    if (intent.flags.json) {
      ctx.stdout.write(`${JSON.stringify(result)}\n`);
      return EXIT_SUCCESS;
    }
    ctx.stdout.write(`${result.response}\n\n(conversationId: ${result.conversationId})\n`);
    return EXIT_SUCCESS;
  };
}

/**
 * A conversation address in the shape the server's id contract requires:
 * `^[a-z][a-z0-9]{1,31}$`, the format `createId()` (cuid2) produces and the
 * consult route validates.
 *
 * Deliberately NOT the `@paralleldrive/cuid2` package. `@pagespace/cli` is
 * published to npm, so every runtime dependency is one every user installs,
 * and what the route actually requires is the FORMAT, not a particular
 * generator. This is 24 base36 characters from a CSPRNG — around 124 bits of
 * entropy, comfortably beyond what a collision-refused-with-409 address needs,
 * and more than cuid2 itself claims. The leading letter is what satisfies the
 * pattern's first character; `randomBytes` rather than `Math.random` because a
 * guessable address is one another caller could reserve first.
 */
function mintConversationId(): string {
  // Base36 of one 128-bit integer, NOT a per-character `byte % 36`: 256 is not
  // a multiple of 36, so mapping each byte independently biases the low digits.
  // The bias would be harmless at this size, but an id generator that looks
  // uniform and is not is exactly the kind of thing that gets copied.
  const body = BigInt(`0x${randomBytes(16).toString('hex')}`).toString(36);
  return `c${body}`;
}

export const agentsAskHandler: CommandHandler = createAgentsAskHandler({ newConversationId: mintConversationId });

// ---------------------------------------------------------------------------
// agents config -> agents.updateConfig
// ---------------------------------------------------------------------------

/** Pure: no I/O. `--set`-style value coercion — JSON first (numbers/booleans/arrays/null), raw string otherwise. */
function coerceSetValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

type SetFlagsResult =
  | { readonly ok: true; readonly values: ReadonlyMap<string, unknown>; readonly rest: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** Pure: no I/O. Merges every repeated `--set key=value` pair; anything else passes through in `rest`. */
function extractSetFlags(args: readonly string[]): SetFlagsResult {
  const values = new Map<string, unknown>();
  const rest: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i] as string;
    if (token === '--set') {
      const pair = args[i + 1];
      if (pair === undefined) return { ok: false, message: 'Flag --set requires a value in the form key=value.' };
      const eq = pair.indexOf('=');
      if (eq <= 0) return { ok: false, message: `Invalid --set value "${pair}": expected key=value.` };
      values.set(pair.slice(0, eq), coerceSetValue(pair.slice(eq + 1)));
      i += 2;
      continue;
    }
    rest.push(token);
    i += 1;
  }
  return { ok: true, values, rest };
}

export const agentsConfigHandler: CommandHandler = async (ctx, intent) => {
  const usage = 'Usage: pagespace agents config <agentPageId> --set <key>=<value> [--set <key>=<value> ...]\n';

  const [agentId, ...rest0] = intent.args;
  if (!agentId) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const parsed = extractSetFlags(rest0);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.rest.length > 0) {
    ctx.stderr.write(`Unknown argument: ${parsed.rest[0]}\n`);
    return EXIT_USAGE_ERROR;
  }
  if (parsed.values.size === 0) {
    ctx.stderr.write(usage);
    return EXIT_USAGE_ERROR;
  }

  const input = { agentId, ...Object.fromEntries(parsed.values) } as UpdateAgentConfigInput;
  const result = await callSdk(ctx.stderr, () => ctx.sdk.agents.updateConfig(input));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }
  ctx.stdout.write(`Updated agent ${result.value.id}: ${result.value.updatedFields.join(', ')}\n`);
  return EXIT_SUCCESS;
};

// ---------------------------------------------------------------------------
// models list -> agents.listModels
// ---------------------------------------------------------------------------

/** Pure: no I/O. */
export function renderModelsList(value: ModelsListResult): string {
  const lines = value.providers.flatMap((provider) =>
    provider.models.map((model) => `${provider.provider}:${model.id}  ${model.displayName}${model.free ? '  [free]' : ''}`),
  );
  if (lines.length === 0) return 'No models.\n';
  return `${lines.join('\n')}\n`;
}

export const modelsListHandler: CommandHandler = async (ctx, intent) => {
  if (intent.args.length > 0) {
    ctx.stderr.write('Usage: pagespace models list [--json]\n');
    return EXIT_USAGE_ERROR;
  }

  const result = await callSdk(ctx.stderr, () => ctx.sdk.agents.listModels({}));
  if (!result.ok) return EXIT_RUNTIME_ERROR;

  if (intent.flags.json) {
    ctx.stdout.write(`${JSON.stringify(result.value)}\n`);
    return EXIT_SUCCESS;
  }
  ctx.stdout.write(renderModelsList(result.value));
  return EXIT_SUCCESS;
};
