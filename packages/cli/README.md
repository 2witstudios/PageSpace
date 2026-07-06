# @pagespace/cli

The `pagespace` command-line client — a thin verb layer over `@pagespace/sdk`. `pagespace login`
authenticates you with a real OAuth 2.1 credential, scoped to key management only — it grants no
content access by itself. `pagespace keys` is the guided way to mint, list, and revoke the
drive-scoped credentials you actually read/write content with, through the same browser consent
screen `pagespace tokens create` (its flag-driven, scriptable equivalent) uses — minting a
credential, either way, is never a silent, agent-runnable call.

## Install

```bash
npm install -g @pagespace/cli
# or, without installing: npx -y -p @pagespace/cli pagespace whoami
```

`npx @pagespace/cli` alone can't pick a bin — the package publishes two (`pagespace`,
`pagespace-mcp`), neither of which matches the unscoped package name `cli` that bare `npx` looks
for. Use `-p @pagespace/cli <bin>` to name the bin explicitly, as above.

This installs two commands: `pagespace` and `pagespace-mcp` — a first-class alias that runs the
same stdio MCP server as `pagespace mcp`, meant for `npx -y -p @pagespace/cli pagespace-mcp` in an
MCP client config with zero local install. See [`pagespace mcp`](#pagespace-mcp) below.

## Quickstart

```bash
# 1. Log in — opens a browser, completes an OAuth 2.1 + PKCE flow, stores the credential locally.
#    This credential is scoped to key management only — it can't read or write any content yet.
pagespace login

# 2. Confirm it worked
pagespace whoami

# 3. Mint a content-scoped key — a guided wizard walks you through picking drive(s) and a role,
#    opens the browser again for consent, and saves the result under a profile name you choose
pagespace keys

# 4. Use that key for actual content access
pagespace drives list --profile <name>
```

No browser on this machine (CI, a remote box, a container)? Use the device flow for step 1
instead:

```bash
pagespace login --device
```

This prints a short code and a verification URL — approve it from any browser, and the CLI polls
until the login completes. Step 3's `pagespace keys` wizard still needs a browser of its own (on
any machine) to approve the drive-scoped grant; for a fully headless mint, use `pagespace tokens
create --drive <id> --role member --save-as-profile <name>` and approve that from any browser
instead of running the interactive wizard.

**Already had a `pagespace login` credential from before this change?** It keeps working exactly
as it did — nothing is revoked, and you won't be silently logged out. The `manage_keys`-only
scope above only takes effect the next time you run a *fresh* `pagespace login` (or `pagespace
logout && pagespace login`).

## Auth

**`pagespace login` is for you, personally. `pagespace tokens create` is for an agent.** Setting
up your own machine? Run `login`. Wiring `pagespace mcp` into an agent, CI job, or any other
automated caller? Run `tokens create --save-as-profile agent` instead — never `login` — and see
[`docs/agent-access.md`](docs/agent-access.md) for what a scoped token does and doesn't protect
against once that agent has real shell access.

- **`pagespace login [--host <url>] [--yes]`** — loopback + PKCE browser login. Stores your
  personal credential for `--host` (default `https://pagespace.ai`), scoped to `manage_keys
  offline_access` — key management only, zero content access. Prints the scope granted on
  success.
- **`pagespace login --device`** — device-authorization flow for headless machines. Same
  `manage_keys`-only scope as above.
- **`pagespace logout [--host <url>] [--all] [--force]`** — clears the stored credential for one
  host, or every host with `--all`.
- **`pagespace whoami [--json]`** — prints the identity and scope the current credential resolves
  to.
- **`pagespace keys`** — the guided, interactive counterpart to `tokens create` below: a TUI
  wizard to create, list, edit, and revoke drive-scoped keys without leaving the terminal.
  `pagespace keys create`, `pagespace keys list [--json]`, and `pagespace keys revoke <tokenId>
  [--yes]` are flag-driven, scriptable equivalents of the same wizard actions.
- **`pagespace tokens create --drive <id> --role member|admin|<roleId> [--drive <id> --role ...] --save-as-profile <name> [--yes]`** —
  mints a credential scoped to the given drive(s)/role(s) for an agent or automated process, not
  you. Opens the same browser consent screen `pagespace login` uses, then stores the result under
  a named profile (`--save-as-profile`, defaulting to the drive id when only one drive is given)
  instead of the `pagespace login` default profile — pass that profile to the agent's invocation
  with `--profile <name>` or by setting `PAGESPACE_PROFILE`. There is no non-interactive way to
  mint a token from the CLI — for a portable credential to hand to a CI job or service account on a
  *different* machine, mint one from **Settings → MCP** in the app instead.
  `pagespace tokens list [--json]` and `pagespace tokens revoke <tokenId>` manage tokens minted
  either way.

### Credential precedence

Every command resolves auth and host the same way:

```
--token / --host flag  >  PAGESPACE_TOKEN / PAGESPACE_API_URL env  >  stored profile credential  >  default host (https://pagespace.ai)
```

"Stored profile credential" means whatever's saved under the resolved profile name — `--profile
<name>` / `PAGESPACE_PROFILE` env, falling back to `"default"` (the profile `pagespace login`
itself writes to). The legacy `PAGESPACE_AUTH_TOKEN` env var (from the old `pagespace-mcp`
package) still works — it fills the `PAGESPACE_TOKEN` slot when that variable isn't set, with a
one-line stderr deprecation notice. Prefer `PAGESPACE_TOKEN` going forward.

**This precedence only ever runs at all if the command names a credential explicitly.** Every
command except `login`, `logout`, `whoami`, `help`, `tokens create`, and the `keys` surface
refuses to run with none of `--token`, `PAGESPACE_TOKEN`, `--profile`, or `PAGESPACE_PROFILE`
given — it will not silently fall through to the `"default"` profile `pagespace login` wrote. So
a bare `pagespace login` alone is never enough to run `pagespace drives list` (or almost anything
else): pass `--profile <name>` (or set `PAGESPACE_PROFILE`) naming a credential minted by
`pagespace keys` or `pagespace tokens create`.

## Command reference

Every command follows `pagespace <resource> <verb> [args] [flags]`.

| Resource | Verbs |
|---|---|
| `drives` | `list [--all]`, `create <name>`, `rename <driveId> <name>`, `trash <driveId> [--yes]`, `restore <driveId>` |
| `pages` | `list --drive <id> [parentId]`, `tree --drive <id> [parentId]`, `read-details <pageId>`, `create <title> <type> [parentId] --drive <id>`, `rename <pageId> <title>`, `move <pageId> <newParentId\|root> <position>`, `trash <pageId> [--all] [--yes]`, `restore <pageId>`, `read <pageId> [--start N] [--end M] [--raw]`, `replace-lines <pageId> --start N [--end M] [--file <path>]`, `export <pageId> --format md\|csv --out <path\|-> [--force]` |
| `sheets` | `edit-cells <pageId> [--json-input <json>]` |
| `trash` | `list --drive <id>` |
| `tasks` | `list <taskListPageId>`, `create <pageId> --title <title> [--priority low\|medium\|high] [--status <slug>] [--due <date>] [--assignee <userId>]`, `update <pageId> <taskId> [--status <slug>] [--title <title>] [--priority ...] [--due <date>]`, `delete <pageId> <taskId> [--yes]`, `reorder <pageId> <taskId> <position>`, `statuses <taskListPageId>`, `create-status <pageId> --name <name> --color <color> --group todo\|in_progress\|done [--position N]`, `assigned` |
| `search` | `text <query> [--drive <id>\|--all-drives] [--max-results <n>]`, `regex <pattern> --drive <id> [--in content\|title\|both] [--max-results <n>]`, `glob <pattern> --drive <id> [--max-results <n>]` |
| `agents` | `list --drive <id>\|--all-drives`, `ask <agentPageId> <message> [--conversation-id <id>] [--context <text>]`, `config <agentPageId> --set <key>=<value>` |
| `models` | `list` |
| `activity` | `<driveId>` |
| `channels` | `send <channelId> <message>` |
| `keys` | `(no args — guided TUI)`, `create --drive <id> --role member\|admin\|<roleId> [--drive <id> --role ...] --save-as-profile <name> [--yes]`, `list [--json]`, `revoke <tokenId> [--yes]` |
| `tokens` | `create --drive <id> --role member\|admin\|<roleId> [--save-as-profile <name>] [--yes]`, `list`, `revoke <tokenId> [--yes]` |

Every command supports `--json` (machine-readable output on stdout, nothing else) and `--host
<url>` / `--token <token>` (override the resolved config for that one call) — except `tokens
create`, which always prints its human-readable consent-flow status; `--json` is silently ignored
there, since minting now blocks on an interactive browser consent screen and never prints a
portable token to parse in the first place.

## `pagespace mcp`

Runs a stdio MCP server generated from the same operation registry the SDK and CLI use — the
entire tool surface derives from one source, so it can't drift from `pagespace`'s own commands.
Auth resolves through the same precedence as every other command; there's no separate MCP auth
path.

**Zero-install, via `npx`** (the primary way to wire this into an MCP client — e.g. Claude Code's
`.mcp.json`):

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "-p", "@pagespace/cli", "pagespace-mcp"],
      "env": {
        "PAGESPACE_TOKEN": "mcp_..."
      }
    }
  }
}
```

Mint the portable `mcp_...` token above from **Settings → MCP** in the app — `pagespace tokens
create` (see [Auth](#auth)) stores its credential locally under a named profile instead of
printing a copyable secret, so it isn't the right tool for populating another machine's `env`
block. If the MCP client runs on *this* machine, skip the portable token: run `pagespace tokens
create --drive <id> --role member --save-as-profile agent`, then set `"env": { "PAGESPACE_PROFILE":
"agent" }` (or `--profile agent`) instead of `PAGESPACE_TOKEN` — that's a credential scoped to the
agent, not your personal login. Do not point an agent's config at `pagespace login`'s stored
credential — it's your personal, key-management-only credential and grants no content access
anyway, so it wouldn't even work. Either way, `mcp` never falls back silently — see
[`docs/agent-access.md`](docs/agent-access.md) for the isolation boundary this can and can't
provide once the agent has real shell access.

**After a global install**, use the `pagespace` bin directly instead:

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "pagespace",
      "args": ["mcp"]
    }
  }
}
```

Both forms run the identical server — `pagespace-mcp` is simply the argv-forwarding alias that
lets `npx` invoke it without a prior `npm install -g`.

Coming from the standalone `pagespace-mcp` npm package (the old, separate ~5.2k-line repo)? See
[Migrating from `pagespace-mcp`](docs/migrating-from-pagespace-mcp.md) — that package is
deprecated in favor of this one; `@pagespace/cli`'s own `pagespace-mcp` bin is not.

## Environment variables

| Variable | Purpose |
|---|---|
| `PAGESPACE_TOKEN` | Bearer credential, same precedence slot as `--token`. |
| `PAGESPACE_API_URL` | API host, same precedence slot as `--host`. Defaults to `https://pagespace.ai`. |
| `PAGESPACE_AUTH_TOKEN` | Deprecated alias for `PAGESPACE_TOKEN`, kept for `pagespace-mcp` compatibility. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | API or runtime error (network failure, server error, authentication rejected). |
| `2` | Usage error (bad flags, unknown command). |

## Design notes

**Pure core, effects at the edges**: `parseArgv` turns `process.argv` into a typed `CommandIntent`
(or a typed `UsageError`) with no I/O. `resolveConfig` applies the precedence above as a pure
function over plain data. The router matches a `CommandIntent` against a static route table and
dispatches to a handler; handlers receive an injected `{ sdk, stdout, stderr, env,
credentialStore }` context and never touch `process.*` directly. Only `src/bin.ts` reads
`process.argv`/`process.env`/`process.stdout`/`process.exitCode`.

**Zero trust**: no token is ever printed — not in output, not in a usage-error message, not in a
log. `--json` mode writes nothing to stdout but the JSON payload itself.

The credential store is the OS keychain with a chmod-0600 file fallback.

## See also

- [`@pagespace/sdk`](../sdk/README.md) — the typed client this CLI is a verb layer over.
- [Migrating from `pagespace-mcp`](docs/migrating-from-pagespace-mcp.md).
- [Agent access](docs/agent-access.md) — what a scoped token does and doesn't protect against for
  an agent with real shell access, and the actual isolation boundary (OS user/container/VM).
- PageSpace page `ea07mt5jvw0flihsbjce1iv9` (epic architecture + non-negotiables) and phase page
  `ntr8palcnmkih8kiy33qo717` (Phase 4 security law) for the binding decisions this package follows.
