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

# 2. Mint a drive-scoped access key. A guided wizard picks the drive(s) and role,
#    opens the browser once more for consent, and stores the key under a name you choose.
pagespace keys

# 3. Activate it for this machine — one quick browser approval.
pagespace keys use <name>

# 4. Commands just work now.
pagespace drives list
pagespace search text "roadmap" --all-drives
```

The model behind those four commands:

- **Your login can't touch content.** `pagespace login` grants key management only
  (`manage_keys` scope). Content access always comes from a **key** — a drive-scoped `mcp_`
  credential you mint in step 2, stored in your OS keychain under the name you picked.
- **Scope changes happen in a browser; use doesn't.** Minting a key, editing its drives, and
  *activating* it on a machine each require a human approving a consent screen. Once a key is
  active, everything in your shell — you, scripts, coding agents running the CLI in bash — uses
  it ambiently, bounded by the drives and role you approved. Explicit credentials
  (`--key`/`--token`/env) always override the active key; `pagespace keys use --off`
  deactivates it.
- **`pagespace mcp` is deliberately excluded** from the active key — MCP configs name their
  credential explicitly so they stay portable and self-describing (see below).

No browser on this machine (CI, container, remote box)? `pagespace login --device` prints a
short code and URL you approve from any browser. Keys are different — their consent redirect
lands on `127.0.0.1` of the machine running the command, so mint (and activate) where you have
a browser, and hand a headless machine a portable token instead: `keys create … --show-token`
prints it exactly once (see [Need the raw token?](#need-the-raw-token-ci-another-machine)).

## Credentials

**`pagespace login` is you. Keys are capabilities.** Minting, re-scoping, or activating a key
always passes through a browser consent screen; there is no silent, agent-runnable way to
create a credential or widen what's ambiently available.

| Command | What it does |
|---|---|
| `pagespace login [--host <url>] [--yes]` | Browser (loopback + PKCE) login. Stores your personal login credential, scoped to `manage_keys offline_access` — zero content access. `--yes` overwrites an existing stored credential. |
| `pagespace login --device` | Device-authorization login for machines without a browser. Same scope. |
| `pagespace logout [--host <url>] [--key <name>] [--all] [--force]` | Revokes and removes a stored credential — one host, or every host with `--all`. `--force` removes the local copy even if server-side revocation fails. |
| `pagespace whoami [--json]` | Shows the identity and scope of the current credential, plus this machine's active key. |
| `pagespace keys` | Interactive wizard: create, list, **edit** (re-scope in place, same secret), **set active**, and revoke keys. Needs a real terminal; in scripts use the subcommands below. |
| `pagespace keys create --drive <id> [--role member\|admin\|<customRoleId>] [--drive … --role …] [--name <name>] [--show-token] [--yes]` | Mints a key scoped to the given drive(s) via browser consent, then stores it under `--name` (defaults to the drive id; required for multiple drives; `default` is reserved for your login). `--yes` overwrites an existing key of the same name. |
| `pagespace keys use <name>` / `pagespace keys use --off` | Makes a stored key this machine's **active key** (browser approval), or deactivates it locally. See above. |
| `pagespace keys list [--json]` | Lists your keys (prefix only — never the secret). |
| `pagespace keys revoke <tokenId> [--yes]` | Revokes a key server-side. Irreversible. |

None of these need `--key`/`--token`: a plain `pagespace login` is enough to drive them all
(`keys create` brings its own browser consent). Everything else — the content commands — needs
a credential, resolved as described next.

### How commands find a credential

Highest precedence first:

```text
--token / --key flags  >  PAGESPACE_TOKEN / PAGESPACE_KEY env  >  the active key (pagespace keys use)  >  loud refusal
```

`--host` / `PAGESPACE_API_URL` select the host the same way (default `https://pagespace.ai`).
Explicit always wins — an agent handed `--key ci` can never be silently retargeted by the
machine's active key. With nothing explicit and no active key, content commands refuse with
instructions rather than falling back to your login credential (which has no content access
anyway). `pagespace mcp` additionally never uses the active key.

### Need the raw token? (CI, another machine)

By default a mint never displays the secret — it goes straight into your keychain. When you
need a portable `mcp_…` token for an `.env` file, CI secret, or a different machine:

- `pagespace keys create … --show-token` prints `PAGESPACE_TOKEN=mcp_…` **once** as the only
  stdout line (pipe-friendly: `… --show-token | pbcopy`). It is never shown again.
- The wizard offers the same show-once choice after a mint.
- Or mint from **Settings → MCP** in the web app.

Anyone holding a raw token gets that key's access — prefer named keys whenever the consumer
runs on the machine that minted them.

## Command reference

Every command is `pagespace <resource> <verb> [args] [flags]`. `pagespace help` prints this
list in the terminal; `pagespace --version` prints the CLI and SDK versions. Global flags,
accepted everywhere: `--json` (machine-readable output on stdout, nothing else), `--host <url>`,
`--token <token>`, `--key <name>`, and `--yes` (skip confirmations).

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

keys      (no args: guided wizard) · create · use · list · revoke   # see Credentials above

mcp       serve the MCP stdio server                                # see below
```

One exception to the global flags: `keys create` ignores `--json` — its stdout is either
ordinary status text or, with `--show-token`, exactly the one `PAGESPACE_TOKEN=…` line.

## `pagespace mcp`

Runs a stdio MCP server whose tools are generated from the same operation registry as the CLI
verbs — identical capabilities, zero drift. Auth resolves like every other command **except**
that the active key deliberately does not apply: an MCP config must name its credential
explicitly, so the config stays portable and self-describing, and it never silently picks up
whatever key you last activated.

**Zero-install** (the usual way to wire an MCP client — e.g. Claude Code's `.mcp.json`):

```json
{
  "mcpServers": {
    "pagespace": {
      "command": "npx",
      "args": ["-y", "-p", "@pagespace/cli", "pagespace-mcp"],
      "env": { "PAGESPACE_KEY": "agent" }
    }
  }
}
```

**After a global install**, `"command": "pagespace", "args": ["mcp"]` does the same thing.

Which credential goes in `env`:

- **MCP client on this machine** — mint a key and reference it by name:
  `pagespace keys create --drive <id> --role member --name agent`, then
  `"env": { "PAGESPACE_KEY": "agent" }` as above. No secret ever appears in the config file.
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
| `PAGESPACE_KEY` | Stored key name to use; same precedence slot as `--key`. |
| `PAGESPACE_API_URL` | API host; same precedence slot as `--host`. Defaults to `https://pagespace.ai`. |
| `PAGESPACE_PROFILE` | Deprecated alias for `PAGESPACE_KEY` (pre-1.5 name); warns on stderr. |
| `PAGESPACE_AUTH_TOKEN` | Deprecated alias for `PAGESPACE_TOKEN` (old `pagespace-mcp` compatibility); warns on stderr. |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | API or runtime error (network failure, server error, authentication rejected). |
| `2` | Usage error (bad flags, unknown command). |

## Notes

- **Upgrading from 0.1.x:** `--profile` is now `--key`, and `keys create --save-as-profile` is
  now `--name` — both old flags error with a pointer to the new name. `PAGESPACE_PROFILE` still
  works as a deprecated alias for `PAGESPACE_KEY`. Stored credentials are untouched: every key
  (and your login) minted by an earlier version keeps working under the same name.
- **Zero trust:** no token is ever printed except behind the explicit `--show-token` opt-in —
  not in output, not in errors, not in logs. `--json` mode writes nothing to stdout but the
  JSON payload. Credentials live in the OS keychain (chmod-0600 file fallback); the active-key
  pointer is just a name, never a secret.
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
- [CHANGELOG](https://github.com/2witstudios/PageSpace/blob/master/packages/cli/CHANGELOG.md)
