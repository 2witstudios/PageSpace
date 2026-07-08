# @pagespace/cli

`pagespace` is the command-line client for [PageSpace](https://pagespace.ai) — work with your
drives, pages, tasks, search, and AI agents from the terminal. It also ships `pagespace mcp`, a
stdio [MCP](https://modelcontextprotocol.io) server that gives coding agents (Claude Code,
Cursor, …) the same tool surface.

Every CLI verb, MCP tool, and [`@pagespace/sdk`](https://github.com/2witstudios/PageSpace/tree/master/packages/sdk)
method is generated from one operation registry, so the three surfaces never drift apart.

## Install

```bash
npm install -g @pagespace/cli
# or run without installing:
npx -y -p @pagespace/cli pagespace whoami
```

This installs two commands: `pagespace` (the CLI) and `pagespace-mcp` (an alias for
`pagespace mcp`, for zero-install MCP configs — see [`pagespace mcp`](#pagespace-mcp)).

> Bare `npx @pagespace/cli` can't work: the package publishes two bins and neither is named
> `cli`, so `npx` has no default to pick. Always name the bin: `npx -y -p @pagespace/cli <bin>`.

## Quickstart

```bash
# 1. Log in — opens your browser for an OAuth 2.1 + PKCE flow.
pagespace login

# 2. Confirm it worked.
pagespace whoami

# 3. Mint a drive-scoped access key. A guided wizard picks the drive(s) and role,
#    opens the browser once more for consent, and saves the key as a named profile.
pagespace keys

# 4. Use that key for content access.
pagespace drives list --profile <name>
```

That's the whole setup. Two things worth knowing about it:

- **Your login can't touch content.** `pagespace login` grants key management only
  (`manage_keys` scope). Content access always comes from a key you mint in step 3 — so the
  credential an agent holds is one *you* scoped, to specific drives, with a role you chose.
- **Keys are profiles.** A minted key is stored in your OS keychain under the profile name you
  picked. Commands select it with `--profile <name>` or `PAGESPACE_PROFILE`.

No browser on this machine (CI, container, remote box)? Use `pagespace login --device`: it
prints a short code and a URL you approve from any browser, and the CLI polls until the login
completes. Key minting is different — its consent redirect lands on `127.0.0.1` of the machine
running the command, so mint keys where you have a browser (your workstation) and hand the
result to the headless machine: either as a profile (same machine) or as a raw token via
`--show-token` (see [Need the raw token?](#need-the-raw-token-ci-another-machine)).

## Credentials

**`pagespace login` is for you. `pagespace keys` is for everything else** — agents, CI, scripts,
MCP clients. Minting a key always passes through a browser consent screen; there is no silent,
agent-runnable way to create a credential.

| Command | What it does |
|---|---|
| `pagespace login [--host <url>] [--yes]` | Browser (loopback + PKCE) login. Stores your personal credential under the `default` profile (or the one named by the global `--profile` flag), scoped to `manage_keys offline_access` — zero content access. `--yes` overwrites an existing stored credential. |
| `pagespace login --device` | Device-authorization login for machines without a browser. Same scope. |
| `pagespace logout [--host <url>] [--profile <name>] [--all] [--force]` | Revokes and removes a stored credential — one host, or every host with `--all`. `--force` removes the local copy even if server-side revocation fails. |
| `pagespace whoami [--json]` | Shows the identity and scope of the current credential. |
| `pagespace keys` | Interactive wizard: create, list, **edit** (re-scope in place, same secret), and revoke keys. Needs a real terminal; in scripts use the subcommands below. |
| `pagespace keys create --drive <id> [--role member\|admin\|<customRoleId>] [--drive … --role …] [--save-as-profile <name>] [--show-token] [--yes]` | Mints a key scoped to the given drive(s) via browser consent, then stores it as a profile. Profile name defaults to the drive id (required via `--save-as-profile` for multiple drives; `default` is reserved for `login`). `--yes` overwrites an existing profile of the same name. |
| `pagespace keys list [--json]` | Lists your keys (prefix only — never the secret). |
| `pagespace keys revoke <tokenId> [--yes]` | Revokes a key server-side. Irreversible. |

None of these need `--token`/`--profile`: a plain `pagespace login` is enough to drive them all
(`keys create` brings its own browser consent). They're the only commands that work that way —
everything else requires an explicit credential, as described below.

### Need the raw token? (CI, another machine)

By default a mint never displays the secret — it goes straight into your keychain. When you
need a portable `mcp_…` token for an `.env` file, CI secret, or a different machine:

- `pagespace keys create … --show-token` prints `PAGESPACE_TOKEN=mcp_…` **once** as the only
  stdout line (pipe-friendly: `… --show-token | pbcopy`). It is never shown again.
- The wizard offers the same show-once choice after a mint.
- Or mint from **Settings → MCP** in the web app.

Anyone holding a raw token gets that key's access — prefer profiles whenever the consumer runs
on the machine that minted the key.

### How commands find a credential

Every command resolves auth and host the same way, highest precedence first:

```text
--token / --host flags  >  PAGESPACE_TOKEN / PAGESPACE_API_URL env  >  stored profile  >  default host (https://pagespace.ai)
```

The stored profile is chosen by `--profile <name>` / `PAGESPACE_PROFILE`, falling back to
`default` (where `login` stores).

**Content commands never fall back silently.** Everything except `login`, `logout`, `whoami`,
`help`, and the `keys` family refuses to run unless you name a credential explicitly — one of
`--token`, `PAGESPACE_TOKEN`, `--profile`, or `PAGESPACE_PROFILE`. That's why step 4 of the
Quickstart says `--profile <name>`: a bare `pagespace login` is never enough to read content,
by design.

## Command reference

Every command is `pagespace <resource> <verb> [args] [flags]`. `pagespace help` prints this
list in the terminal; `pagespace --version` prints the CLI and SDK versions. Global flags,
accepted everywhere: `--json` (machine-readable output on stdout, nothing else), `--host <url>`,
`--token <token>`, `--profile <name>`, and `--yes` (skip confirmations).

```text
drives    list [--all]                # --all includes trashed drives
          create <name>
          rename <driveId> <name>
          set-home-page <driveId> <pageId|--clear>
          trash <driveId> [--yes]     # asks you to type the drive name unless --yes
          restore <driveId>

pages     list --drive <driveId> [parentId]
          tree --drive <driveId> [parentId]
          read <pageId> [--start N] [--end M] [--raw]
          read-details <pageId>
          create <title> <type> [parentId] --drive <driveId>
          rename <pageId> <title>
          move <pageId> <newParentId|root> <newPosition>
          replace-lines <pageId> --start N [--end M] [--file <path>]
          export <pageId> --format md|csv --out <path|-> [--force]
          trash <pageId> [--all] [--yes]
          restore <pageId>

sheets    edit-cells <pageId> [--json-input <json>]

trash     list --drive <driveId>

tasks     list <taskListPageId>
          create <pageId> --title <title> [--priority low|medium|high] [--status <slug>] [--due <date>] [--assignee <userId>]
          update <pageId> <taskId> [--title <title>] [--status <slug>] [--priority low|medium|high] [--due <date>]
          delete <pageId> <taskId> [--yes]
          reorder <pageId> <taskId> <position>
          statuses <taskListPageId>
          create-status <pageId> --name <name> --color <color> --group todo|in_progress|done [--position N]
          assigned                    # tasks assigned to you, across drives

search    text <query> [--drive <driveId>|--all-drives] [--max-results <n>]
          regex <pattern> --drive <driveId> [--in content|title|both] [--max-results <n>]
          glob <pattern> --drive <driveId> [--max-results <n>]

agents    list --drive <driveId>|--all-drives
          ask <agentPageId> <message> [--conversation-id <id>] [--context <text>]
          config <agentPageId> --set <key>=<value> [--set <key>=<value> …]

models    list

activity  <driveId>

channels  send <channelId> <message>

keys      (no args: guided wizard) · create · list · revoke   # see Credentials above

mcp       serve the MCP stdio server                          # see below
```

One exception to the global flags: `keys create` ignores `--json` — its stdout is either
ordinary status text or, with `--show-token`, exactly the one `PAGESPACE_TOKEN=…` line.

## `pagespace mcp`

Runs a stdio MCP server whose tools are generated from the same operation registry as the CLI
verbs — identical capabilities, zero drift. Auth resolves exactly like every other command, and
like every content command it **refuses to start without an explicit credential** — it will
never silently pick up your personal login.

**Zero-install** (the usual way to wire an MCP client — e.g. Claude Code's `.mcp.json`):

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "-p", "@pagespace/cli", "pagespace-mcp"],
      "env": { "PAGESPACE_PROFILE": "agent" }
    }
  }
}
```

**After a global install**, `"command": "pagespace", "args": ["mcp"]` does the same thing.

Which credential goes in `env`:

- **MCP client on this machine** — mint a key and reference it by profile:
  `pagespace keys create --drive <id> --role member --save-as-profile agent`, then
  `"env": { "PAGESPACE_PROFILE": "agent" }` as above. No secret ever appears in the config file.
- **MCP client on another machine / CI** — get a raw token (`keys create … --show-token`, or
  **Settings → MCP** in the app) and set `"env": { "PAGESPACE_TOKEN": "mcp_…" }`.
- **Never your `login` credential** — it's personal, and it has no content access anyway.

A scoped key limits what the *server* will allow; it is not an isolation boundary for an agent
with shell access on your machine. See
[Agent access](https://github.com/2witstudios/PageSpace/blob/master/packages/cli/docs/agent-access.md)
for the threat model, and the [PageSpace MCP docs](https://pagespace.ai/docs/integrations/mcp)
for client-by-client setup.

Coming from the standalone `pagespace-mcp` npm package? It's deprecated in favor of this one
(the `pagespace-mcp` *bin* in this package is not) — see
[Migrating from `pagespace-mcp`](https://github.com/2witstudios/PageSpace/blob/master/packages/cli/docs/migrating-from-pagespace-mcp.md).

## Environment variables

| Variable | Purpose |
|---|---|
| `PAGESPACE_TOKEN` | Bearer credential; same precedence slot as `--token`. |
| `PAGESPACE_PROFILE` | Stored profile to use; same precedence slot as `--profile`. |
| `PAGESPACE_API_URL` | API host; same precedence slot as `--host`. Defaults to `https://pagespace.ai`. |
| `PAGESPACE_AUTH_TOKEN` | Deprecated alias for `PAGESPACE_TOKEN` (old `pagespace-mcp` compatibility); warns on stderr. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | API or runtime error (network failure, server error, authentication rejected). |
| `2` | Usage error (bad flags, unknown command). |

## Notes

- **Upgrading:** a credential stored by an earlier `pagespace login` keeps working — nothing is
  revoked. The `manage_keys`-only scope applies the next time you run a fresh `login`.
- **Zero trust:** no token is ever printed except behind the explicit `--show-token` opt-in —
  not in output, not in errors, not in logs. `--json` mode writes nothing to stdout but the
  JSON payload. Credentials live in the OS keychain (chmod-0600 file fallback).
- **Pure core:** argv parsing, config resolution, and routing are pure functions over plain
  data; only the bin entrypoint touches `process.*`. Handlers receive an injected
  `{ sdk, stdout, stderr, env, credentialStore }` context, which is why the whole CLI is
  testable without a network.

## See also

- [`@pagespace/sdk`](https://github.com/2witstudios/PageSpace/tree/master/packages/sdk) — the
  typed client this CLI is a verb layer over.
- [PageSpace MCP integration docs](https://pagespace.ai/docs/integrations/mcp)
- [Agent access & isolation](https://github.com/2witstudios/PageSpace/blob/master/packages/cli/docs/agent-access.md)
- [Migrating from `pagespace-mcp`](https://github.com/2witstudios/PageSpace/blob/master/packages/cli/docs/migrating-from-pagespace-mcp.md)
