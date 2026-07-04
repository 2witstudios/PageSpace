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
 * directly; there is no non-text part to summarize. `agents.ask` is also
 * non-idempotent (a retried consult would double-execute the agent), so a
 * timeout is never retried — it renders an honest "may still have run"
 * message instead.
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

export const agentsAskHandler: CommandHandler = async (ctx, intent) => {
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

  let result: Awaited<ReturnType<PageSpaceClient['agents']['ask']>>;
  try {
    result = await ctx.sdk.agents.ask({
      agentId,
      question,
      context: scanned.values.get('--context'),
      conversationId: scanned.values.get('--conversation-id'),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      ctx.stderr.write(
        `Request to agent ${agentId} timed out — it may still be running. This call is never automatically retried (retrying would risk double-executing a non-idempotent request); check the agent's conversation history before asking again.\n`,
      );
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
