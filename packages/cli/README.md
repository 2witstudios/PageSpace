# @pagespace/cli

The `pagespace` command-line client — a thin verb layer over `@pagespace/sdk`. `pagespace login`
replaces hand-minted `mcp_*` tokens with a real OAuth 2.1 credential; `pagespace tokens create`
mints scoped agent tokens from the terminal instead of Settings → MCP.

**Pure core, effects at the edges**: `parseArgv` turns `process.argv` into a typed `CommandIntent`
(or a typed `UsageError`) with no I/O. `resolveConfig` applies the fixed precedence — `--token`/
`--host` flags > `PAGESPACE_TOKEN`/`PAGESPACE_API_URL` env > stored profile credential > defaults
(`https://pagespace.ai`) — as a pure function over plain data. The router matches a `CommandIntent`
against a static route table and dispatches to a handler; handlers receive an injected
`{ sdk, stdout, stderr, env, credentialStore }` context and never touch `process.*` directly. Only
`src/bin.ts` reads `process.argv`/`process.env`/`process.stdout`/`process.exitCode`.

**Exit codes** (fixed contract, every command tests against it): `0` success, `1` API/runtime
error, `2` usage error.

**Zero trust**: no token is ever printed — not in output, not in a usage-error message, not in a
log. `--json` mode writes nothing to stdout but the JSON payload itself.

The credential store (OS keychain + chmod-0600 file fallback) lands in Phase 4 task 2; this
package currently ships a `NullCredentialStore` placeholder so the handler contract doesn't change
shape when the real store arrives.

See PageSpace page `ea07mt5jvw0flihsbjce1iv9` (epic architecture + non-negotiables) and phase page
`ntr8palcnmkih8kiy33qo717` (Phase 4 security law) for the binding decisions this package follows.
