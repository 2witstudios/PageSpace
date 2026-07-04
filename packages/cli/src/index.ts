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

// Multi-host credential store (keychain + 0600 file fallback) — Phase 4 task 2.
export { CompositeCredentialStore, createCredentialStore } from './credentials/store.js';
export type { CredentialStore, CreateCredentialStoreOptions } from './credentials/store.js';
export { FileCredentialStore, PermissionError, defaultCredentialsPath } from './credentials/file-store.js';
export type { FileCredentialStoreOptions } from './credentials/file-store.js';
export { createNativeKeychainAdapter } from './credentials/keychain.js';
export type { KeychainAdapter, KeychainCredential } from './credentials/keychain.js';
export {
  CredentialsFileFormatError,
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
export type { CredentialSummary, CredentialsFile, HostCredential } from './credentials/serialize.js';

// Fixed exit code contract.
export { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from './exit-codes.js';
export type { ExitCode } from './exit-codes.js';

// Built-in commands.
export { helpHandler } from './commands/help.js';
export { CLI_VERSION, versionHandler } from './commands/version.js';
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
export { confirmIdentity, whoamiOperation } from './auth/confirm-identity.js';
export { openBrowser } from './auth/open-browser.js';

// Token revocation (RFC 7009) and refresh_token grant — Phase 4 task 5,
// reused by `pagespace logout`/`pagespace whoami`.
export { createRevokeToken } from './auth/revoke-token.js';
export type { RevokeResult, RevokeToken, RevokeTokenParams } from './auth/revoke-token.js';
export { createRefreshToken, RefreshTokenError } from './auth/refresh-token.js';
export type { RefreshedTokens, RefreshToken, RefreshTokenParams } from './auth/refresh-token.js';

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
// `silent-refresh.ts` is a distinct effect from task 5's `refresh-token.ts`
// above: it adapts the refresh_token grant to the SDK's OAuthTokenProvider
// contract (absolute expiry timestamps, classifyHttpError-based retry vs.
// terminal classification) for this resolver's own silent-refresh wiring.
export { missingCredentialsMessage, resolveAuth } from './auth/resolve.js';
export type { AuthSource, ResolveAuthEnv, ResolveAuthFlags } from './auth/resolve.js';
export { createRefreshAccessToken } from './auth/silent-refresh.js';
export { buildAuthProvider, enforceAuth, FailingAuthProvider } from './auth/auth-context.js';
export type { BuildAuthProviderDeps, DiscoverTokenEndpoint, EnforceAuthDeps } from './auth/auth-context.js';

// `tokens create/list/revoke` (Phase 4 task 6). Auth flows only through
// ctx.sdk (task 7's resolver, enforced by run.ts before dispatch) — these
// commands have no auth wiring of their own.
export { parseTokensCreateArgs, parseTokensRevokeArgs } from './commands/tokens/args.js';
export type { CreateTokenArgs, DriveScopeArg, RevokeTokenArgs } from './commands/tokens/args.js';
export { tokensCreateHandler } from './commands/tokens/create.js';
export { tokensListHandler } from './commands/tokens/list.js';
export { createTokensRevokeHandler, tokensRevokeHandler } from './commands/tokens/revoke.js';
export type { RevokeHandlerDeps } from './commands/tokens/revoke.js';

// Composition root.
export { run } from './run.js';
export type { RunDependencies } from './run.js';
