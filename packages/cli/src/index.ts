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

// Credential store — placeholder pending Phase 4 task 2.
export { NullCredentialStore } from './credential-store.js';
export type { CredentialStore, StoredProfile } from './credential-store.js';

// Multi-host credential store (keychain + 0600 file fallback) — Phase 4 task 2.
export { CompositeCredentialStore, createCredentialStore } from './credentials/store.js';
export type { CredentialStore as HostCredentialStore, CreateCredentialStoreOptions } from './credentials/store.js';
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

// Composition root.
export { run } from './run.js';
export type { RunDependencies } from './run.js';
