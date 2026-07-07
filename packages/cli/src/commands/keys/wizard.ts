/**
 * `pagespace keys` (no subcommand) — the guided TUI wizard (Phase 9 task 5),
 * the primary user-facing deliverable of this phase: since `pagespace login`
 * now grants only a `manage_keys`-scoped credential, this is the fast path to
 * actually create/list/edit/revoke scoped access keys without opening the web
 * Settings > MCP page.
 *
 * This is the ONLY file in the `keys` command that imports `@clack/prompts` —
 * every decision (which menu choices are offered, how a drive/role selection
 * becomes a scope string, what a key list line looks like, whether to offer
 * revoking the old key after an edit) lives in the pure `./logic.js` module
 * and is unit-tested there. This file is just the terminal I/O shell: it
 * calls a clack primitive, hands the raw answer to a pure function, and acts
 * on the result. A `symbol` return from any clack prompt means the user hit
 * Ctrl+C — every such cancellation aborts the current sub-flow back to the
 * top-level menu rather than mid-flow (`abortSubflow`), except at the menu
 * `select` itself, where it ends the wizard.
 *
 * Minting (Create) reuses `buildTokenScope`/`resolveTokenProfileName` and
 * `runLoopbackLogin` exactly as `keys create` (`./create.js`) does — same
 * deps shape (`TokensCreateHandlerDeps`), same effect adapters wired at the
 * bottom of this file. Edit no longer mints at all: it re-scopes the
 * selected key IN PLACE via the `update_key:<id>` grant (same secret, see
 * `runEdit`). Both still require the real browser-consent step-up — there
 * is no path to drive access, new or updated, without it.
 */
import { randomBytes } from 'node:crypto';
import * as clack from '@clack/prompts';
import { PAGESPACE_CLI_CLIENT_ID } from '../../auth/client.js';
import { TOKEN_ENV_VAR_NAME } from '../../auth/resolve.js';
import { confirmIdentity } from '../../auth/confirm-identity.js';
import { createDiscoverMetadata } from '../../auth/discover.js';
import { createExchangeCode } from '../../auth/exchange-code.js';
import { createLoopbackServer } from '../../auth/create-loopback-server.js';
import { openBrowser } from '../../auth/open-browser.js';
import { unrefWaitMs } from '../../auth/wait.js';
import { runLoopbackLogin } from '../../auth/loopback-flow.js';
import type { LoopbackLoginResult } from '../../auth/loopback-flow.js';
import { resolveConfig } from '../../config/resolve.js';
import { createCredentialStore } from '../../credentials/store.js';
import type { CredentialStore } from '../../credentials/store.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, type ExitCode } from '../../exit-codes.js';
import type { HandlerContext } from '../../handler-context.js';
import type { CommandHandler } from '../../router/router.js';
import { DEFAULT_LOGIN_TIMEOUT_MS, DEFAULT_MAX_PORT_ATTEMPTS } from '../login.js';
import type { DriveScopeArg } from './args.js';
import { buildKeyUpdateScope, resolveTokenProfileName, type TokensCreateHandlerDeps } from './create.js';
import { renderAgentWiringGuidance, SHOW_TOKEN_PROMPT, WIZARD_INTRO_HINT } from './guidance.js';
import {
  availableMenuChoices,
  buildWizardScope,
  driveMultiSelectOptions,
  driveRoleChoiceToScopeArg,
  keySelectOptions,
  menuSelectOptions,
  NON_INTERACTIVE_KEYS_MESSAGE,
  preselectedDriveIds,
  renderKeysTable,
  roleSelectOptions,
} from './logic.js';
import type { DriveOption, DriveRoleChoice, DriveRoleSelection, KeySummary } from './logic.js';

type FlowOutcome = ExitCode | null;

function abortSubflow(): null {
  clack.log.warn('Cancelled — back to menu.');
  return null;
}

async function fetchDrives(ctx: HandlerContext): Promise<readonly DriveOption[] | null> {
  try {
    const drives = await ctx.sdk.drives.list({ tokenScopable: true });
    return drives.map((drive) => ({ id: drive.id, name: drive.name, role: drive.role }));
  } catch (error) {
    clack.log.error(`Failed to load drives: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function fetchCustomRoles(ctx: HandlerContext, driveId: string): Promise<readonly { id: string; name: string }[]> {
  try {
    const { roles } = await ctx.sdk.roles.list({ driveId });
    return roles.map((role) => ({ id: role.id, name: role.name }));
  } catch {
    // Custom roles are an enhancement on top of Member/Admin, never required — a
    // fetch failure here just means the wizard offers fewer role choices, not a
    // hard stop for the drive/role selection flow.
    return [];
  }
}

async function fetchKeys(ctx: HandlerContext): Promise<readonly KeySummary[] | null> {
  try {
    return await ctx.sdk.tokens.list({});
  } catch (error) {
    clack.log.error(`Failed to load your keys: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Mirrors `keys create`'s outcome-to-message mapping (`commands/keys/create.ts`) as plain strings for a spinner. */
function describeMintFailure(result: Exclude<LoopbackLoginResult, { outcome: 'success' }>): string {
  switch (result.outcome) {
    case 'timeout':
      return 'Consent timed out waiting for the browser redirect.';
    case 'state_mismatch':
      return 'Consent failed: the authorization response did not match this request.';
    case 'access_denied':
      return 'Consent was denied.';
    case 'authorize_error':
      return `Consent failed: ${result.error}`;
    case 'token_exchange_failed':
      return `Consent failed while exchanging the authorization code: ${result.message}`;
    case 'port_bind_failed':
      return 'Could not bind a local loopback port to receive the consent redirect.';
    case 'discovery_failed':
      return `Could not discover the OAuth server configuration: ${result.message}`;
    default: {
      const unreachable: never = result;
      throw new Error(`Unhandled consent outcome: ${JSON.stringify(unreachable)}`);
    }
  }
}

async function selectRoleForDrive(ctx: HandlerContext, driveId: string, driveName: string): Promise<DriveRoleChoice | null> {
  const customRoles = await fetchCustomRoles(ctx, driveId);
  const choice = await clack.select<DriveRoleChoice>({
    message: `Role for "${driveName}"?`,
    options: [...roleSelectOptions(customRoles)],
  });
  return clack.isCancel(choice) ? null : choice;
}

/** Shared by Create and Edit's drive-selection step (Edit passes `initialDriveIds` to pre-select the key's current scopes). */
async function selectDriveRoleScopes(
  ctx: HandlerContext,
  drives: readonly DriveOption[],
  message: string,
  initialDriveIds: readonly string[],
): Promise<readonly DriveRoleSelection[] | null> {
  const driveIds = await clack.multiselect({
    message,
    options: [...driveMultiSelectOptions(drives)],
    initialValues: [...initialDriveIds],
    required: true,
  });
  if (clack.isCancel(driveIds)) return null;

  const selections: DriveRoleSelection[] = [];
  for (const driveId of driveIds) {
    const drive = drives.find((candidate) => candidate.id === driveId);
    if (!drive) continue;
    const choice = await selectRoleForDrive(ctx, driveId, drive.name);
    if (choice === null) return null;
    selections.push({ driveId, choice });
  }
  return selections;
}

async function promptProfileName(driveScopeArgs: readonly DriveScopeArg[], message: string): Promise<string | null> {
  const name = await clack.text({
    message,
    placeholder: driveScopeArgs.length === 1 ? driveScopeArgs[0].id : undefined,
    validate: (value) => {
      const trimmed = (value ?? '').trim();
      const result = resolveTokenProfileName({ saveAsProfile: trimmed.length > 0 ? trimmed : undefined, drives: driveScopeArgs });
      return result.ok ? undefined : result.message;
    },
  });
  if (clack.isCancel(name)) return null;
  const trimmed = name.trim();
  const result = resolveTokenProfileName({ saveAsProfile: trimmed.length > 0 ? trimmed : undefined, drives: driveScopeArgs });
  return result.ok ? result.name : null;
}

/** Whether it's safe to write the profile: either nothing is stored there yet, or the user explicitly confirmed overwriting it. */
async function isProfileWriteConfirmed(store: CredentialStore, host: string, profileName: string): Promise<boolean> {
  const existing = await store.get(host, profileName);
  if (!existing) return true;
  const overwrite = await clack.confirm({
    message: `A stored credential for ${host} (profile "${profileName}") already exists. Overwrite it?`,
    initialValue: false,
  });
  return !clack.isCancel(overwrite) && overwrite;
}

/**
 * The runLoopbackLogin dep wiring shared by every wizard consent flow
 * (Create's mint, Edit's in-place update) — one place to thread a new
 * effect or default through, so the two flows can't silently diverge.
 */
function consentFlowDeps(deps: TokensCreateHandlerDeps, s: ReturnType<typeof clack.spinner>) {
  return {
    clientId: PAGESPACE_CLI_CLIENT_ID,
    randomBytes: deps.randomBytes,
    discoverMetadata: deps.discoverMetadata,
    startServer: deps.startServer,
    maxPortAttempts: deps.maxPortAttempts ?? DEFAULT_MAX_PORT_ATTEMPTS,
    openBrowser: deps.openBrowser,
    onBrowserOpenFailed: (url: string) => {
      s.message(`Could not open a browser automatically. Open this URL to continue: ${url}`);
    },
    waitMs: deps.waitMs,
    timeoutMs: deps.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
    exchangeCode: deps.exchangeCode,
    confirmIdentity: deps.confirmIdentity,
    now: deps.now,
  };
}

async function mintScopedKey(
  deps: TokensCreateHandlerDeps,
  store: CredentialStore,
  params: { readonly host: string; readonly scope: string; readonly profileName: string },
): Promise<LoopbackLoginResult> {
  const s = clack.spinner();
  s.start(`Opening your browser to approve access for profile "${params.profileName}" on ${params.host}...`);

  // Captured, never printed while the spinner is live — only surfaced behind
  // the explicit show-once confirm below.
  let mintedToken: string | null = null;

  const result = await runLoopbackLogin({
    ...consentFlowDeps(deps, s),
    host: params.host,
    scope: params.scope,
    credentialStore: store,
    profile: params.profileName,
    onMintedStaticToken: (token) => {
      mintedToken = token;
    },
  });

  if (result.outcome === 'success') {
    s.stop(`Created profile "${params.profileName}" on ${params.host}, scoped to: ${params.scope}.`);
    if (mintedToken !== null) {
      const show = await clack.confirm({ message: SHOW_TOKEN_PROMPT, initialValue: false });
      if (!clack.isCancel(show) && show) {
        clack.note(`${TOKEN_ENV_VAR_NAME}=${mintedToken}`, 'Copy it now — shown once');
      }
    }
    clack.note(renderAgentWiringGuidance({ profileName: params.profileName, host: params.host }).join('\n'), 'Wire up an agent');
  } else {
    s.error(describeMintFailure(result));
  }
  return result;
}

interface ScopeAndMintMessages {
  readonly selectDrives: string;
  readonly profileName: string;
  readonly confirmMint: (scope: string) => string;
}

/**
 * Create's "pick drives/roles, name a profile, confirm, mint" flow (Edit
 * used to share it back when editing meant minting a replacement — it now
 * re-scopes in place, see `runEdit`). Constructs the credential store exactly ONCE and
 * threads that single instance through both the overwrite check and the mint
 * itself, so `CompositeCredentialStore`'s one-way keychain-degradation notice
 * (`credentials/store.ts`) can only ever print once per flow, matching how
 * `keys create` (`commands/keys/create.ts`) does it — two independently
 * constructed stores would each probe and degrade independently, printing the
 * "OS keychain unavailable" notice twice for what is logically one operation.
 */
async function selectScopeAndMint(
  ctx: HandlerContext,
  deps: TokensCreateHandlerDeps,
  host: string,
  drives: readonly DriveOption[],
  initialDriveIds: readonly string[],
  messages: ScopeAndMintMessages,
): Promise<LoopbackLoginResult | null> {
  const selections = await selectDriveRoleScopes(ctx, drives, messages.selectDrives, initialDriveIds);
  if (selections === null) {
    abortSubflow();
    return null;
  }

  const scopeResult = buildWizardScope(selections);
  if (!scopeResult.ok) {
    clack.log.error(scopeResult.message);
    return null;
  }
  const driveScopeArgs = selections.map((selection) => driveRoleChoiceToScopeArg(selection.driveId, selection.choice));

  const profileName = await promptProfileName(driveScopeArgs, messages.profileName);
  if (profileName === null) {
    abortSubflow();
    return null;
  }

  const store = deps.createCredentialStore();
  if (!(await isProfileWriteConfirmed(store, host, profileName))) {
    abortSubflow();
    return null;
  }

  const proceed = await clack.confirm({ message: messages.confirmMint(scopeResult.scope) });
  if (clack.isCancel(proceed) || !proceed) {
    abortSubflow();
    return null;
  }

  return mintScopedKey(deps, store, { host, scope: scopeResult.scope, profileName });
}

async function runCreate(ctx: HandlerContext, deps: TokensCreateHandlerDeps, host: string): Promise<FlowOutcome> {
  const drives = await fetchDrives(ctx);
  if (drives === null) return null;
  if (drives.length === 0) {
    clack.log.warn('No drives available to scope a key to.');
    return null;
  }

  await selectScopeAndMint(ctx, deps, host, drives, [], {
    selectDrives: 'Select drives to grant access to',
    profileName: 'Name this credential (used as its local profile name)',
    confirmMint: (scope) => `Mint a new key scoped to: ${scope}?`,
  });
  return null;
}

/**
 * Edit re-scopes the selected key IN PLACE: same `mcp_tokens` row, same
 * secret — the `update_key:<id>` grant (`buildKeyUpdateScope`) rides the
 * same browser-consent step-up as a mint, but the server updates the
 * existing token's drive scopes (`ok_mcp_update`) and returns no secret, so
 * nothing is persisted locally and there is no replacement profile to name
 * or old key to revoke. A hostile or pre-`update_key` server answering this
 * request with a real mint is rejected by `runLoopbackLogin` itself (its
 * update-request guard fails the flow before anything is persisted); the
 * non-"default" sentinel `profile` passed below is defense-in-depth only and
 * is never written on any reachable path.
 */
async function runEdit(ctx: HandlerContext, deps: TokensCreateHandlerDeps, host: string, keys: readonly KeySummary[]): Promise<FlowOutcome> {
  const keyId = await clack.select({ message: 'Which key would you like to edit?', options: [...keySelectOptions(keys)] });
  if (clack.isCancel(keyId)) return abortSubflow();
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) return abortSubflow();

  const drives = await fetchDrives(ctx);
  if (drives === null) return null;
  if (drives.length === 0) {
    clack.log.warn('No drives available to scope a key to.');
    return null;
  }

  const selections = await selectDriveRoleScopes(ctx, drives, `Select drives for "${key.name}"`, preselectedDriveIds(key));
  if (selections === null) return abortSubflow();

  const driveScopeArgs = selections.map((selection) => driveRoleChoiceToScopeArg(selection.driveId, selection.choice));
  const updateScope = buildKeyUpdateScope(key.id, driveScopeArgs);
  if (!updateScope.ok) {
    clack.log.error(updateScope.message);
    return null;
  }

  const proceed = await clack.confirm({
    message: `Update "${key.name}" to: ${updateScope.driveScope}? The key keeps its existing secret.`,
  });
  if (clack.isCancel(proceed) || !proceed) return abortSubflow();

  const s = clack.spinner();
  s.start(`Opening your browser to approve the new scopes for "${key.name}" on ${host}...`);

  const result = await runLoopbackLogin({
    ...consentFlowDeps(deps, s),
    host,
    scope: updateScope.scope,
    credentialStore: deps.createCredentialStore(),
    profile: `edit-${key.id}`,
  });

  if (result.outcome !== 'success') {
    s.error(describeMintFailure(result));
    return null;
  }

  // Fail closed on a server that claims success for a DIFFERENT key than
  // this consent named — nothing was stored locally either way
  // (runLoopbackLogin's update-request guard), so the only risk is a false
  // success message, but a false success message about key scopes is still
  // a lie worth refusing to tell.
  if (result.updatedTokenId !== key.id) {
    s.error(`The server reported updating a different key than "${key.name}". Verify this key's scopes with "pagespace keys list".`);
    return null;
  }

  s.stop(`Updated "${key.name}". Its secret is unchanged — existing configurations keep working.`);
  clack.log.info(
    'If this key is saved as a local profile, the profile\'s stored scope list may still show the old scopes — the server-side scopes above are what\'s enforced.',
  );
  return null;
}

async function runRevoke(ctx: HandlerContext, keys: readonly KeySummary[]): Promise<FlowOutcome> {
  const keyId = await clack.select({ message: 'Which key would you like to revoke?', options: [...keySelectOptions(keys)] });
  if (clack.isCancel(keyId)) return abortSubflow();
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) return abortSubflow();

  const confirmed = await clack.confirm({ message: `Revoke "${key.name}"? This cannot be undone.`, initialValue: false });
  if (clack.isCancel(confirmed) || !confirmed) return abortSubflow();

  try {
    await ctx.sdk.tokens.revoke({ tokenId: key.id });
    clack.log.success(`Revoked "${key.name}".`);
  } catch (error) {
    clack.log.error(`Failed to revoke: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

async function runList(keys: readonly KeySummary[]): Promise<FlowOutcome> {
  clack.note(renderKeysTable(keys).join('\n'), 'Your keys');
  return null;
}

export function createKeysHandler(deps: TokensCreateHandlerDeps): CommandHandler {
  return async (ctx, intent) => {
    // The router's longest-prefix match only tries `['keys','create'|'list'|'revoke']`
    // before falling back to this bare `['keys']` route — a typo'd subcommand
    // (`pagespace keys lsit`) would otherwise silently land here with the
    // typo as a leftover positional arg, launching the wizard instead of
    // reporting the unrecognized subcommand.
    if (intent.args.length > 0) {
      ctx.stderr.write(
        `Unknown "keys" subcommand: ${intent.args.join(' ')}. Did you mean "pagespace keys create", "pagespace keys list", or "pagespace keys revoke"?\n`,
      );
      return EXIT_USAGE_ERROR;
    }

    if (!ctx.isTTY) {
      ctx.stderr.write(`${NON_INTERACTIVE_KEYS_MESSAGE}\n`);
      return EXIT_RUNTIME_ERROR;
    }

    const { host } = resolveConfig({
      flags: { host: intent.flags.host },
      env: { PAGESPACE_API_URL: ctx.env.PAGESPACE_API_URL },
      profile: null,
    });

    clack.intro('pagespace keys');
    clack.log.message(WIZARD_INTRO_HINT);

    for (;;) {
      const keys = await fetchKeys(ctx);
      if (keys === null) {
        clack.outro('Failed to load your keys.');
        return EXIT_RUNTIME_ERROR;
      }

      const choice = await clack.select({
        message: 'What would you like to do?',
        options: [...menuSelectOptions(availableMenuChoices(keys.length))],
      });

      if (clack.isCancel(choice) || choice === 'exit') {
        clack.outro(clack.isCancel(choice) ? 'Cancelled.' : 'Bye.');
        return EXIT_SUCCESS;
      }

      const outcome =
        choice === 'create'
          ? await runCreate(ctx, deps, host)
          : choice === 'list'
            ? await runList(keys)
            : choice === 'edit'
              ? await runEdit(ctx, deps, host, keys)
              : await runRevoke(ctx, keys);

      if (outcome !== null) return outcome;
    }
  };
}

function nodeRandomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

export const keysHandler: CommandHandler = createKeysHandler({
  createCredentialStore,
  randomBytes: nodeRandomBytes,
  discoverMetadata: createDiscoverMetadata(),
  startServer: createLoopbackServer,
  openBrowser,
  waitMs: unrefWaitMs,
  exchangeCode: createExchangeCode(),
  confirmIdentity,
  now: Date.now,
});
