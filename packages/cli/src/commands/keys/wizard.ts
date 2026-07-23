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
 * Minting (Create) reuses `buildTokenScope`/`resolveNewKeyName` and
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
import { createPollDeviceToken } from '../../auth/poll-device-token.js';
import { createRequestDeviceAuthorization } from '../../auth/request-device-authorization.js';
import { createSigintFlag } from '../../auth/sigint.js';
import { runLoopbackLogin } from '../../auth/loopback-flow.js';
import type { LoopbackLoginResult } from '../../auth/loopback-flow.js';
import { resolveConfig } from '../../config/resolve.js';
import { credentialSecret } from '../../credentials/serialize.js';
import type { HostCredential } from '../../credentials/serialize.js';
import { createCredentialStore } from '../../credentials/store.js';
import type { CredentialStore } from '../../credentials/store.js';
import { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR, type ExitCode } from '../../exit-codes.js';
import type { HandlerContext } from '../../handler-context.js';
import type { CommandHandler } from '../../router/router.js';
import { DEFAULT_LOGIN_TIMEOUT_MS, DEFAULT_MAX_PORT_ATTEMPTS } from '../login.js';
import type { DriveScopeArg } from './args.js';
import { buildKeyUpdateScope, resolveNewKeyName, type TokensCreateHandlerDeps } from './create.js';
import { findServerTokenId, runActivateCeremony } from './use.js';
import { renderAgentWiringGuidance, SHOW_TOKEN_PROMPT, WIZARD_INTRO_HINT } from './guidance.js';
import {
  allDrivesDowngradeConfirmMessage,
  availableMenuChoices,
  buildWizardScope,
  confirmMintMessage,
  driveMultiSelectOptions,
  driveRoleChoiceToScopeArg,
  driveTargetSelectOptions,
  DRIVE_TARGET_SELECT_MESSAGE,
  keySelectOptions,
  menuSelectOptions,
  NON_INTERACTIVE_KEYS_MESSAGE,
  preselectedDriveIds,
  renderKeysTable,
  roleSelectOptions,
} from './logic.js';
import type { DriveOption, DriveRoleChoice, DriveRoleSelection, DriveTargetChoice, KeySummary } from './logic.js';

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

async function promptKeyName(
  driveScopeArgs: readonly DriveScopeArg[],
  message: string,
  options: { readonly allDrives?: boolean } = {},
): Promise<string | null> {
  const name = await clack.text({
    message,
    placeholder: !options.allDrives && driveScopeArgs.length === 1 ? driveScopeArgs[0].id : undefined,
    validate: (value) => {
      const trimmed = (value ?? '').trim();
      const result = resolveNewKeyName({
        name: trimmed.length > 0 ? trimmed : undefined,
        drives: driveScopeArgs,
        allDrives: options.allDrives,
      });
      return result.ok ? undefined : result.message;
    },
  });
  if (clack.isCancel(name)) return null;
  const trimmed = name.trim();
  const result = resolveNewKeyName({
    name: trimmed.length > 0 ? trimmed : undefined,
    drives: driveScopeArgs,
    allDrives: options.allDrives,
  });
  return result.ok ? result.name : null;
}

/** Whether it's safe to write the named credential: either nothing is stored there yet, or the user explicitly confirmed overwriting it. */
async function isKeyWriteConfirmed(store: CredentialStore, host: string, keyName: string): Promise<boolean> {
  const existing = await store.get(host, keyName);
  if (!existing) return true;
  const overwrite = await clack.confirm({
    message: `A stored credential for ${host} (key "${keyName}") already exists. Overwrite it?`,
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
  params: { readonly host: string; readonly scope: string; readonly keyName: string; readonly displayScope?: string },
): Promise<LoopbackLoginResult> {
  const s = clack.spinner();
  s.start(`Opening your browser to approve access for key "${params.keyName}" on ${params.host}...`);

  // Captured, never printed while the spinner is live — only surfaced behind
  // the explicit show-once confirm below.
  let mintedToken: string | null = null;

  const result = await runLoopbackLogin({
    ...consentFlowDeps(deps, s),
    host: params.host,
    scope: params.scope,
    credentialStore: store,
    profile: params.keyName,
    onMintedStaticToken: (token) => {
      mintedToken = token;
    },
  });

  if (result.outcome === 'success') {
    s.stop(`Created key "${params.keyName}" on ${params.host}, scoped to: ${params.displayScope ?? params.scope}.`);
    if (mintedToken !== null) {
      const show = await clack.confirm({ message: SHOW_TOKEN_PROMPT, initialValue: false });
      if (!clack.isCancel(show) && show) {
        clack.note(`${TOKEN_ENV_VAR_NAME}=${mintedToken}`, 'Copy it now — shown once');
      }
    }
    clack.note(renderAgentWiringGuidance({ keyName: params.keyName, host: params.host }).join('\n'), 'Wire up an agent');
  } else {
    s.error(describeMintFailure(result));
  }
  return result;
}

interface ScopeAndMintMessages {
  readonly selectDrives: string;
  readonly keyName: string;
}

/** Up-front "specific drives or all drives" choice — only Create offers this; see `DriveTargetChoice`'s doc comment (`logic.js`) for why Edit doesn't. */
async function selectDriveTarget(): Promise<DriveTargetChoice | null> {
  const choice = await clack.select<DriveTargetChoice>({
    message: DRIVE_TARGET_SELECT_MESSAGE,
    options: [...driveTargetSelectOptions()],
  });
  return clack.isCancel(choice) ? null : choice;
}

/**
 * Create's "pick drives/roles (or all drives), name the key, confirm, mint"
 * flow (Edit used to share it back when editing meant minting a replacement —
 * it now re-scopes in place, see `runEdit`). Constructs the credential store
 * exactly ONCE and threads that single instance through both the overwrite
 * check and the mint itself, so `CompositeCredentialStore`'s one-way
 * keychain-degradation notice (`credentials/store.ts`) can only ever print
 * once per flow, matching how `keys create` (`commands/keys/create.ts`) does
 * it — two independently constructed stores would each probe and degrade
 * independently, printing the "OS keychain unavailable" notice twice for what
 * is logically one operation.
 */
async function selectScopeAndMint(
  ctx: HandlerContext,
  deps: TokensCreateHandlerDeps,
  host: string,
  drives: readonly DriveOption[],
  initialDriveIds: readonly string[],
  messages: ScopeAndMintMessages,
): Promise<LoopbackLoginResult | null> {
  const target = await selectDriveTarget();
  if (target === null) {
    abortSubflow();
    return null;
  }

  let driveScopeArgs: readonly DriveScopeArg[];
  let selections: readonly DriveRoleSelection[];

  if (target === 'all') {
    driveScopeArgs = [];
    selections = [];
  } else {
    const selected = await selectDriveRoleScopes(ctx, drives, messages.selectDrives, initialDriveIds);
    if (selected === null) {
      abortSubflow();
      return null;
    }
    selections = selected;
    driveScopeArgs = selected.map((selection) => driveRoleChoiceToScopeArg(selection.driveId, selection.choice));
  }

  const keyName = await promptKeyName(driveScopeArgs, messages.keyName, { allDrives: target === 'all' });
  if (keyName === null) {
    abortSubflow();
    return null;
  }

  const scopeResult = buildWizardScope(selections, { allDrives: target === 'all', name: keyName });

  if (!scopeResult.ok) {
    clack.log.error(scopeResult.message);
    return null;
  }

  const store = deps.createCredentialStore();
  if (!(await isKeyWriteConfirmed(store, host, keyName))) {
    abortSubflow();
    return null;
  }

  const proceed = await clack.confirm({ message: confirmMintMessage(scopeResult.driveScope, target) });
  if (clack.isCancel(proceed) || !proceed) {
    abortSubflow();
    return null;
  }

  return mintScopedKey(deps, store, {
    host,
    scope: scopeResult.scope,
    keyName,
    displayScope: scopeResult.driveScope,
  });
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
    keyName: 'Name this key (agents on this machine reference it by this name)',
  });
  return null;
}

/**
 * Edit re-scopes the selected key IN PLACE: same `mcp_tokens` row, same
 * secret — the `update_key:<id>` grant (`buildKeyUpdateScope`) rides the
 * same browser-consent step-up as a mint, but the server updates the
 * existing token's drive scopes (`ok_mcp_update`) and returns no secret, so
 * nothing is persisted locally and there is no replacement key to name
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

  // Edit can only ever re-scope among specific drives — widening an existing
  // key to all-drives isn't offered (see `DriveTargetChoice`'s doc comment,
  // `logic.js`, for why). Surface the escape hatch up front rather than
  // leaving a user who wants that stuck guessing.
  clack.log.info('Editing narrows or changes which specific drives this key can access. To grant access to ALL drives instead, run "pagespace keys create --all-drives" to mint a new key.');

  const selections = await selectDriveRoleScopes(ctx, drives, `Select drives for "${key.name}"`, preselectedDriveIds(key));
  if (selections === null) return abortSubflow();

  const driveScopeArgs = selections.map((selection) => driveRoleChoiceToScopeArg(selection.driveId, selection.choice));
  const updateScope = buildKeyUpdateScope(key.id, driveScopeArgs);
  if (!updateScope.ok) {
    clack.log.error(updateScope.message);
    return null;
  }

  // Downgrade guard: this key currently has NO driveScopes with isScoped ===
  // false, i.e. it's an --all-drives key (see `KeySummary`'s doc comment) —
  // about to be narrowed to the specific-drive set just selected. This
  // direction is the one Edit CAN actually perform in place (unlike the
  // reverse — see `DriveTargetChoice`'s doc comment, `logic.js`), but it's
  // still a real access reduction the user should confirm explicitly.
  if (!key.isScoped) {
    const confirmDowngrade = await clack.confirm({
      message: allDrivesDowngradeConfirmMessage(key.name, driveScopeArgs.length),
      initialValue: false,
    });
    if (clack.isCancel(confirmDowngrade) || !confirmDowngrade) return abortSubflow();
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
    "If this key is stored locally, its locally cached scope list may still show the old scopes — the server-side scopes above are what's enforced.",
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

/** Whether a locally stored credential is the one a server-side key summary describes. */
function matchesServerKey(credential: HostCredential, key: KeySummary): boolean {
  return credential.kind !== 'oauth' && credentialSecret(credential).startsWith(key.tokenPrefix);
}

/**
 * Set active key — the wizard form of `pagespace keys use <name>`, sharing
 * `runActivateCeremony` (`./use.js`) so the two surfaces cannot drift. The
 * picker lists the same server-side keys Edit/Revoke use (the currently
 * active one hinted), but the activation records a LOCAL credential name —
 * so the picked key is reverse-mapped to the locally stored credential whose
 * token it prefixes; a key with no local credential on this machine cannot
 * be activated here.
 */
async function runUse(ctx: HandlerContext, deps: TokensCreateHandlerDeps, host: string, keys: readonly KeySummary[]): Promise<FlowOutcome> {
  const store = deps.createCredentialStore();

  const activeName = await ctx.activeKeyStore.getActiveKey(host);
  const activeCredential = activeName === null ? null : await store.get(host, activeName);
  const activeKeyId = activeCredential === null ? null : findServerTokenId(keys, activeCredential);

  const keyId = await clack.select({
    message: 'Which key should be active on this machine?',
    options: [...keySelectOptions(keys, activeKeyId)],
  });
  if (clack.isCancel(keyId)) return abortSubflow();
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) return abortSubflow();

  // Try the exact name match FIRST: the local profile a key is stored under
  // is always the server-side key's own name (create.ts's resolveNewKeyName
  // writes it verbatim, and the mint embeds that same string as the scope's
  // name:<...> token), so this is an instant, exact hit in the overwhelmingly
  // common "create, then immediately activate" case. This isn't just an
  // optimization — real OS keychain backends (`@napi-rs/keyring`'s
  // `findCredentialsAsync`, `credentials/keychain.ts`) have been observed
  // truncating every returned account name at the embedded NUL byte
  // `keychainAccountKey` uses to separate host/profile, collapsing every
  // non-default-profile credential to the same bare host string and making
  // the enumeration below unable to distinguish any of them. `store.get`
  // takes the account string as an explicit parameter rather than depending
  // on the native binding to correctly return it, so it's unaffected.
  let localName: string | null = null;
  const exactCredential = await store.get(host, key.name);
  if (exactCredential !== null && matchesServerKey(exactCredential, key)) {
    localName = key.name;
  } else {
    // Fallback for the case an exact name won't catch: the key was renamed
    // server-side (or the local profile predates a rename) so the stored
    // credential lives under a different name than the key's current one.
    // Best-effort only — subject to the same enumeration bug noted above.
    const localNames = (await store.listCredentialNames?.(host)) ?? [];
    for (const name of localNames) {
      const credential = await store.get(host, name);
      if (credential !== null && matchesServerKey(credential, key)) {
        localName = name;
        break;
      }
    }
  }
  if (localName === null) {
    clack.log.error(
      `No locally stored credential matches "${key.name}" — a key can only be activated on a machine that stores it. Create one here with "Create a new key".`,
    );
    return null;
  }

  const s = clack.spinner();
  s.start(`Opening your browser to approve activating "${key.name}" on ${host}...`);

  const result = await runActivateCeremony(ctx, deps, {
    host,
    name: localName,
    tokenId: key.id,
    store,
    onBrowserOpenFailed: (url) => {
      s.message(`Could not open a browser automatically. Open this URL to continue: ${url}`);
    },
  });

  if (!result.ok) {
    s.error(result.message);
    return null;
  }

  s.stop(`"${localName}" is now the active key for ${host}.`);
  clack.log.info(
    'Commands on this machine will use it unless --key/PAGESPACE_KEY/--token override it. Run "pagespace keys use --off" to deactivate.',
  );
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
        `Unknown "keys" subcommand: ${intent.args.join(' ')}. Did you mean "pagespace keys create", "pagespace keys list", "pagespace keys revoke", or "pagespace keys use"?\n`,
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
      credential: null,
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
              : choice === 'use'
                ? await runUse(ctx, deps, host, keys)
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
  requestDeviceAuthorization: createRequestDeviceAuthorization(),
  pollDeviceToken: createPollDeviceToken(),
  isInterrupted: createSigintFlag(),
  now: Date.now,
});
