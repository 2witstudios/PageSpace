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

// Fixed exit code contract.
export { EXIT_RUNTIME_ERROR, EXIT_SUCCESS, EXIT_USAGE_ERROR } from './exit-codes.js';
export type { ExitCode } from './exit-codes.js';

// Built-in commands.
export { helpHandler } from './commands/help.js';
export { CLI_VERSION, versionHandler } from './commands/version.js';

// Composition root.
export { run } from './run.js';
export type { RunDependencies } from './run.js';
