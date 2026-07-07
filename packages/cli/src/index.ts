// argv grammar — the pure entry point every command's tests parse through.
export { parseArgv } from './argv/parse.js';
export type { CommandIntent, ParsedFlags, ParseResult, UsageError } from './argv/parse.js';

// Config precedence resolver (flags > env > profile > defaults).
export { DEFAULT_HOST, resolveConfig } from './config/resolve.js';
export type { ConfigEnv, ConfigFlags, ConfigProfile, ConfigSources, ResolvedConfig } from './config/resolve.js';

// Router — resolves a parsed command path to a handler.
export { resolveRoute } from './router/router.js';
export type { CommandHandler, Route, RouteResolution } from './router/router.js';

// Handler context — what every command handler receives instead of `process.*`.
export type { HandlerContext, OutputSink } from './handler-context.js';

// Destructive-verb confirmation gate (Phase 5 task 1) — shared by every
// `trash` verb: --yes short-circuits, non-TTY without it fails closed,
// TTY without it prompts via the injected `HandlerContext.prompt`.
export { confirmationFailureMessage, confirmDestructive, isYes } from './confirm.js';
export type { ConfirmDestructiveOptions, ConfirmOutcome } from './confirm.js';

// Multi-host credential store (keychain + 0600 file fallback) — Phase 4 task 2.
export { CompositeCredentialStore, createCredentialStore } from './credentials/store.js';
export type { CredentialStore, CreateCredentialStoreOptions } from './credentials/store.js';
export { FileCredentialStore, PermissionError, defaultCredentialsPath } from './credentials/file-store.js';
export type { FileCredentialStoreOptions } from './credentials/file-store.js';
export { createNativeKeychainAdapter, keychainAccountKey, parseKeychainAccountKey } from './credentials/keychain.js';
export type { KeychainAccount, KeychainAdapter, KeychainCredential } from './credentials/keychain.js';
export {
  credentialSecret,
  CredentialsFileFormatError,
  DEFAULT_PROFILE_NAME,
  emptyCredentialsFile,
  getHost,
  isSecureMode,
  listSummaries,
  parseCredentialsFile,
  parseHostCredential,
  permissionFixItMessage,
  removeHost,
  serializeCredentialsFile,
  serializeHostCredential,
  tokenPrefix,
  upsertHost,
} from './credentials/serialize.js';
export type { CredentialSummary, CredentialsFile, HostCredential, HostProfiles, OAuthHostCredential, StaticHostCredential } from './credentials/serialize.js';

// Fixed exit code contract.
export { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from './exit-codes.js';
export type { ExitCode } from './exit-codes.js';

// Built-in commands.
export { createHelpHandler, groupHelpCommands } from './commands/help.js';
export type { HelpCommandDescriptor, HelpGroup } from './commands/help.js';
export { helpHandler, ROUTES } from './router/routes.js';
export type { RouteEntry } from './router/routes.js';
export { CLI_VERSION, versionHandler } from './commands/version.js';

// Drives & pages verbs (Phase 5 task 1) — thin projections over the
// `drives.*`/`pages.*` SDK operations.
export {
  drivesCreateHandler,
  drivesListHandler,
  drivesRenameHandler,
  drivesRestoreHandler,
  drivesSetHomePageHandler,
  drivesTrashHandler,
  renderDrive,
  renderDrivesList,
} from './commands/drives.js';
export {
  pagesCreateHandler,
  pagesListHandler,
  pagesMoveHandler,
  pagesReadDetailsHandler,
  pagesRenameHandler,
  pagesRestoreHandler,
  pagesTrashHandler,
  pagesTreeHandler,
  renderPage,
  renderPagesList,
  renderPagesTree,
} from './commands/pages.js';
export { renderTrashTree, trashListHandler } from './commands/trash.js';

// Search verbs (Phase 5 task 4) — thin projections over the `search.*` SDK
// operations (glob/regex are drive-scoped; text is the multi-drive op with
// searchType: 'text').
export {
  renderGlobSearch,
  renderMultiDriveSearch,
  renderRegexSearch,
  searchGlobHandler,
  searchRegexHandler,
  searchTextHandler,
} from './commands/search.js';

// Agents, models & activity/channels verbs (Phase 5 task 5) — thin
// projections over the `agents.*`/`activity.*`/`channels.*` SDK operations
// (this same task wires the activity/channels namespaces onto the client
// facade — see `@pagespace/sdk`'s `client.ts`).
export {
  agentsAskHandler,
  agentsConfigHandler,
  agentsListHandler,
  modelsListHandler,
  renderAgentsList,
  renderAgentsMultiDriveList,
  renderModelsList,
} from './commands/agents.js';
export { activityHandler, renderActivity } from './commands/activity.js';
export { channelsSendHandler } from './commands/channels.js';

// Tasks verbs (Phase 5 task 3) — thin projections over the `tasks.*` SDK
// operations (and, for list/statuses, the already-wired `pages.read`
// TASK_LIST branch).
export {
  extractTaskCreateFlags,
  extractTaskStatusCreateFlags,
  extractTaskUpdateFlags,
  renderTasksList,
  renderTaskStatuses,
  tasksAssignedHandler,
  tasksCreateHandler,
  tasksCreateStatusHandler,
  tasksDeleteHandler,
  tasksListHandler,
  tasksReorderHandler,
  tasksStatusesHandler,
  tasksUpdateHandler,
} from './commands/tasks.js';
export type {
  ExtractTaskCreateFlagsResult,
  ExtractTaskStatusCreateFlagsResult,
  ExtractTaskUpdateFlagsResult,
  TaskCreateFlags,
  TaskStatusCreateFlags,
  TaskUpdateFlags,
} from './commands/tasks.js';

// Content & export verbs (Phase 5 task 2) — thin projections over the
// documents/export SDK operations.
export {
  createPagesReplaceLinesHandler,
  extractLineRangeFlags,
  pagesReadHandler,
  pagesReplaceLinesHandler,
} from './commands/content.js';
export type { ContentSourceDeps } from './commands/content.js';
export { createSheetsEditCellsHandler, sheetsEditCellsHandler } from './commands/sheets.js';
export type { SheetsEditCellsDeps } from './commands/sheets.js';
export { createPagesExportHandler, pagesExportHandler } from './commands/export.js';
export type { PagesExportDeps } from './commands/export.js';
export {
  createLoginHandler,
  DEFAULT_LOGIN_SCOPE,
  DEFAULT_LOGIN_TIMEOUT_MS,
  DEFAULT_MAX_PORT_ATTEMPTS,
  loginHandler,
} from './commands/login.js';
export type { LoginHandlerDeps } from './commands/login.js';
export { createLogoutHandler, formatLogoutLine, logoutHandler, summarizeLogout } from './commands/logout.js';
export type { LogoutHandlerDeps, LogoutHostOutcome } from './commands/logout.js';
export { createWhoamiHandler, whoamiHandler } from './commands/whoami.js';
export type { WhoamiHandlerDeps } from './commands/whoami.js';

// Login flow — the pure loopback+PKCE state machine (Phase 4 task 3) and its
// production effect adapters, reused by `pagespace whoami`/`logout` (task 5).
export { runLoopbackLogin } from './auth/loopback-flow.js';
export type {
  ConfirmIdentity,
  DiscoverMetadata,
  DiscoveredMetadata,
  ExchangeCode,
  ExchangeCodeParams,
  ExchangedTokens,
  Identity,
  LoopbackCallback,
  LoopbackLoginDeps,
  LoopbackLoginResult,
  LoopbackServer,
  OpenBrowser,
  RandomBytes,
  StartLoopbackServer,
  WaitMs,
} from './auth/loopback-flow.js';
export { createLoopbackServer, LOOPBACK_HOST, PortBindError } from './auth/create-loopback-server.js';
export { createDiscoverMetadata, DiscoveryError } from './auth/discover.js';
export { createExchangeCode, TokenExchangeError } from './auth/exchange-code.js';
export { CONFIRM_IDENTITY_TIMEOUT_MS, confirmIdentity, whoamiOperation } from './auth/confirm-identity.js';
export { openBrowser } from './auth/open-browser.js';
export { unrefWaitMs, waitMs } from './auth/wait.js';

// Token revocation (RFC 7009) — Phase 4 task 5, reused by `pagespace logout`.
// The refresh_token grant itself is `silent-refresh.ts`'s
// `createRefreshAccessToken` (exported below), shared by `pagespace whoami`
// and the non-interactive auth resolver — no bespoke duplicate here.
export { createRevokeToken } from './auth/revoke-token.js';
export type { RevokeResult, RevokeToken, RevokeTokenParams } from './auth/revoke-token.js';

// Device-authorization login flow (Phase 4 task 4) — RFC 8628, the headless
// counterpart to the loopback flow, sharing its discovery/persistence plumbing.
export { decideNextPoll, runDeviceLogin } from './auth/device-flow.js';
export type {
  DeviceAuthorization,
  DeviceLoginDeps,
  DeviceLoginOutcome,
  DeviceLoginResult,
  DevicePollState,
  DeviceTokenResult,
  NextPollDecision,
  PollDeviceToken,
  RequestDeviceAuthorization,
} from './auth/device-flow.js';
export { createRequestDeviceAuthorization, DeviceAuthorizationError } from './auth/request-device-authorization.js';
export { createPollDeviceToken } from './auth/poll-device-token.js';
export {
  createLoginDeviceHandler,
  loginDeviceHandler,
} from './commands/login-device.js';
export type { LoginDeviceHandlerDeps } from './commands/login-device.js';

// Non-interactive auth precedence resolver (Phase 4 task 7; ADR 0003 §4/§6):
// --token flag > PAGESPACE_TOKEN env > stored profile (silent refresh) > fail.
// `silent-refresh.ts`'s `createRefreshAccessToken` is the sole refresh_token
// grant effect in the CLI (SDK OAuthTokenProvider contract: absolute expiry
// timestamps, classifyHttpError-based retry vs. terminal classification) —
// shared by this resolver's silent-refresh wiring and by `pagespace whoami`.
export { missingCredentialsMessage, resolveAuth, resolveProfileName } from './auth/resolve.js';
export type {
  AuthSource,
  ResolveAuthEnv,
  ResolveAuthFlags,
  ResolveProfileNameEnv,
  ResolveProfileNameFlags,
} from './auth/resolve.js';
export { createRefreshAccessToken } from './auth/silent-refresh.js';
export { buildAuthProvider, enforceAuth, FailingAuthProvider } from './auth/auth-context.js';
export type { BuildAuthProviderDeps, DiscoverTokenEndpoint, EnforceAuthDeps } from './auth/auth-context.js';

// `pagespace keys create/list/revoke` (Phase 4 task 6, consolidated under
// `keys` by a later Phase 9 follow-up), plus the guided `pagespace keys` TUI
// wizard (Phase 9 task 5). Auth flows only through ctx.sdk (task 7's
// resolver, enforced by run.ts before dispatch) — these commands have no
// auth wiring of their own beyond `create`'s own browser-consent mint.
export { parseTokensCreateArgs, parseTokensRevokeArgs } from './commands/keys/args.js';
export type { CreateTokenArgs, DriveScopeArg, RevokeTokenArgs } from './commands/keys/args.js';
export {
  buildKeyUpdateScope,
  buildTokenScope,
  createTokensCreateHandler,
  resolveTokenProfileName,
  tokensCreateHandler,
} from './commands/keys/create.js';
export type { BuildKeyUpdateScopeResult, BuildTokenScopeResult, ResolveTokenProfileNameResult, TokensCreateHandlerDeps } from './commands/keys/create.js';
export { tokensList, tokensListHandler } from './commands/keys/list.js';
export { tokensRevoke, tokensRevokeHandler } from './commands/keys/revoke.js';

// `pagespace keys`'s guided TUI wizard. `logic.ts` is the pure
// decision-logic layer the wizard's `@clack/prompts` effects shell calls
// into; `wizard.ts` is that effects shell.
export {
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
} from './commands/keys/logic.js';
export type {
  CustomRoleOption,
  DriveOption,
  DriveRoleChoice,
  DriveRoleSelection,
  KeyDriveScope,
  KeySummary,
  SelectOption,
  WizardMenuChoice,
} from './commands/keys/logic.js';
export { renderAgentWiringGuidance, SHOW_TOKEN_PROMPT, WIZARD_INTRO_HINT } from './commands/keys/guidance.js';
export type { AgentWiringGuidanceParams } from './commands/keys/guidance.js';
export { createKeysHandler, keysHandler } from './commands/keys/wizard.js';

// Legacy `PAGESPACE_AUTH_TOKEN` env var support (Phase 6 task 1) — folded
// into `run.ts`'s single auth-resolution path, never a second one.
export { resolveEnvToken } from './auth/legacy-token-env.js';
export type { ResolvedEnvToken } from './auth/legacy-token-env.js';

// `pagespace mcp` — the stdio MCP adapter generated from the operation
// registry (Phase 6 task 1). `mcp/serve.ts` walks the registry into MCP
// tool definitions via the pure conversion in `mcp/tool-convert.ts`.
export { operationToMcpTool, validateToolInput, formatInvalidInputResult, formatSdkErrorResult, formatSuccessResult, formatUnknownToolResult } from './mcp/tool-convert.js';
export type { McpCallResult, McpJsonSchema, McpTextContent, McpToolAnnotations, McpToolDefinition, ValidatedToolInput } from './mcp/tool-convert.js';
export { buildOperationRegistry, createMcpServer } from './mcp/serve.js';
export type { CreateMcpServerOptions, McpSdkClient } from './mcp/serve.js';
export { createMcpHandler, mcpHandler } from './commands/mcp.js';
export type { McpHandlerDeps } from './commands/mcp.js';

// `pagespace-mcp` bin — a first-class, zero-install entry point for the
// same `pagespace mcp` stdio server; forces the "mcp" route.
export { buildPagespaceMcpArgv, runPagespaceMcpBin } from './pagespace-mcp-bin.js';

// Composition root.
export { isLongRunningCommand, run } from './run.js';
export type { RunDependencies } from './run.js';
