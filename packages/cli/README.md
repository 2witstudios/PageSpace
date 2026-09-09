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
  active, `pagespace` content commands run by this OS user — by you, a script, or a coding
  agent driving the CLI in bash — use it by default, bounded by the drives and role you
  approved. Explicit credentials (`--key`/`--token`/env) always override the active key;
  `pagespace keys use --off` deactivates it.
- **`pagespace mcp` is deliberately excluded** from the active key — MCP configs name their
  credential explicitly so they stay portable and self-describing (see below).
- **A key can describe itself, but cannot manage keys.** `pagespace keys describe` reports the
  credential in use — drives, role, and the permissions it actually resolves to — and works
  under a key. Because it reports on a *content* credential rather than managing keys, it is the
  one `keys` verb that follows the content-command rule above: name the credential
  (`--key=<name>`, `--token`, the env vars, or an active key). `keys list`/`revoke`/`use` and the
  wizard manage the whole set of keys you hold, so they need your login instead, and refuse a key
  outright rather than failing halfway through.

No browser on this machine (CI, container, remote box)? `pagespace login --device` prints a
short code and URL you approve from any browser. Keys are different — their consent redirect
lands on `127.0.0.1` of the machine running the command, so mint (and activate) where you have
a browser, and hand a headless machine a portable token instead: `keys create … --show-token`
prints it exactly once (see [Need the raw token?](#need-the-raw-token-ci-another-machine)).

## Credentials

**`pagespace login` is you. Keys are capabilities.** Minting, re-scoping, or activating a key
always passes through a browser consent screen; there is no silent, agent-runnable way to
create a credential or widen what's ambiently available. That consent screen is a barrier
against *silent* privilege escalation, not against a same-OS-user process that can already read
the credential store — see [Agent access & isolation](docs/agent-access.md) for the exact
trust boundary.

| Command | What it does |
|---|---|
| `pagespace login [--host <url>] [--yes]` | Browser (loopback + PKCE) login. Stores your personal login credential, scoped to `manage_keys offline_access` — zero content access. `--yes` overwrites an existing stored credential. |
| `pagespace login --device` | Device-authorization login for machines without a browser. Same scope. |
| `pagespace logout [--host <url>] [--key <name>] [--all] [--force]` | Revokes and removes a stored credential — one host, or every host with `--all`. `--force` removes the local copy even if server-side revocation fails. |
| `pagespace whoami [--json]` | Shows the identity and scope of the current credential, plus this machine's active key. |
| `pagespace keys` | Interactive wizard: create, list, **edit** (re-scope in place, same secret), **set active**, and revoke keys. Needs a real terminal; in scripts use the subcommands below. |
| `pagespace keys create --drive <id> [--role member\|admin\|<customRoleId>] [--drive … --role …] [--name <name>] [--show-token] [--yes]` | Mints a key scoped to the given drive(s) via browser consent, then stores it under `--name` (defaults to the drive id; required for multiple drives; `default` is reserved for your login). `--yes` overwrites an existing key of the same name. |
| `pagespace keys use <name>` / `pagespace keys use --off` | Makes a stored key this machine's **active key** (browser approval), or deactivates it locally. See above. |
| `pagespace keys list [--json]` | Lists your keys (prefix only — never the secret), with the role granted on each drive. Needs your login — a key cannot list keys; see `keys describe`. |
| `pagespace keys describe [--page <pageId>] [--json]` | What the credential this machine would use actually is: its drives, the role granted in each, and the **effective** permissions that role resolves to (view/edit/share/delete). Drive-level permissions cover the drive itself (creating a top-level page, sharing or deleting it); a page inside can be narrower, so `--page` resolves that page too. The one `keys` verb a key can run about itself — and, unlike its siblings, it reports on a **content** credential, so it needs one named: `--key=<name>`, `--token`, the env vars, or an active key. A bare `pagespace keys describe` with only a personal login is refused, like any other content command. |
| `pagespace keys revoke <tokenId> [--yes]` | Revokes a key server-side. Irreversible. |

`--role` binds to the `--drive` immediately before it, not to every `--drive` on the command
line: `--drive a --drive b --role admin` grants **admin only on `b`**; `a` gets no fixed role at
all — it's scoped to *whatever role you personally hold on drive `a` at request time*, which
changes if your own membership does. Give every drive its own `--role` when you want a fixed
grant: `--drive a --role admin --drive b --role admin`.

A plain `pagespace login` is enough to drive these — with one exception. `keys create`, `list`,
`revoke`, `use` and the wizard all *manage* keys, so they need your login and nothing else
(`keys create` brings its own browser consent). **`keys describe` is the exception**: it reports on
a *content* credential rather than managing keys, so it needs one named — `--key=<name>`,
`--token`, the env vars, or an active key — exactly like the content commands below. A bare
`pagespace keys describe` with only a login is refused.

Everything else — the content commands — needs a credential, resolved as described next.

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
`--token <token>`, `--key <name>`, `--timeout <seconds>` (how long to wait for the one request the
command makes), and `--yes` (skip confirmations).

```text
drives    list [--all]                # --all includes trashed drives
          create <name>
          rename <driveId> <name>
          update-context <driveId> <drivePrompt>   # sets the drive's AI context prompt (max 10000 chars)
          set-home-page <driveId> <pageId|--clear>
          trash <driveId> [--yes]     # asks you to type the drive name unless --yes
          restore <driveId>

roles     list <driveId>
          get <driveId> <roleId>
          create <driveId> <name> [--description <text>] [--color <hex>] [--is-default true|false]
                 [--drive-wide-view true|false --drive-wide-edit true|false --drive-wide-share true|false]
          update <driveId> <roleId> [--name <text>] [--description <text>|--clear-description] [--color <hex>|--clear-color]
                 [--is-default true|false] [--drive-wide-view/--drive-wide-edit/--drive-wide-share true|false | --clear-drive-wide]
          delete <driveId> <roleId> [--yes]
          set-page-permissions <driveId> <roleId> <pageId> --view true|false --edit true|false --share true|false
          set-drive-wide-permissions <driveId> <roleId> --view true|false --edit true|false --share true|false
          remove-page-permissions <driveId> <roleId> <pageId> [--yes]

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

files     upload <path> --drive <driveId> [--parent <pageId>] [--title <title>] [--mime <type>]

sheets    describe <pageId>                  # tabs and sizes, reads no rows
          query <pageId> [--where <json>] [--select A,B] [--order-by A:desc] [--limit N] [--offset N] [--tab N]
          rows <pageId> [--from-row N] [--limit N] [--tab N]
          append <pageId> [--json-input <json>] [--tab N]
          update-cells <pageId> [--json-input <json>] [--tab N]
          delete-rows <pageId> --from-row N --count N [--tab N] [--yes]
          edit-cells <pageId> [--json-input <json>]

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

conversations list <agentPageId>            # an agent's conversations, newest first
              read <agentPageId> <conversationId>   # the messages in one conversation

models    list

activity  <driveId>

channels  send <channelId> <message>

keys      (no args: guided wizard) · create · use · list · describe · revoke

env       enroll <enrollmentId> <code>   # bind THIS machine to a local environment (one-time code)
          token <enrollmentId>           # prove this machine holds its key; prints a short-lived bridge token

mcp       serve the MCP stdio server                                # see below
```

One exception to the global flags: `keys create` ignores `--json` — its stdout is either
ordinary status text or, with `--show-token`, exactly the one `PAGESPACE_TOKEN=…` line.

## `pagespace env` — this machine as a local environment

### What you are agreeing to

`pagespace env connect` lets PageSpace run commands and read and write files **on this computer,
under your own user account**. Nothing runs unless a policy file you own allows it, and in `ask`
mode you see the exact command before it runs. Two things follow from approving one, and the
second surprises people:

- It runs with your privileges, exactly as if you had typed it into this terminal yourself. It can
  read any file you can read, change any file you can change, reach anything on your network that
  you can reach, and use any credential sitting in your home directory. There is no sandbox
  around it.
- Approving a command is remembered **per program, not per session**. The approval is keyed on
  you, this environment, the operation, and the *program* that ran (`/usr/bin/git` — for a shell
  command line, every program it names), for the time you choose: once, until the daemon stops,
  30 days (the default), or until you revoke it. So approving `git status` lets `git push` run
  from a new chat tomorrow with no prompt, and does **not** let `rm` run: `rm` asks. A command
  line whose programs cannot be pinned down (`$(…)`, `eval`, a nested `sh -c`, `find -exec`,
  `sudo`) is never remembered and asks every time. Approvals live in
  `~/.pagespace/env-approvals.json` (yours, 0600; a file anybody else can write is ignored), and
  PageSpace can revoke one (from the environment's settings, over a signed frame the daemon checks
  against its pinned key) but never add one.

**A file write can become a command.** `fs_write` inside your roots runs without a prompt, because
writing a file looks like the harmless half of this. It is not: a file's *contents* can be a
command that something else runs later. Writing `.git/hooks/pre-commit` and making it executable
means your next ordinary `git commit` runs it, as you, with no approval anywhere. So a write the
daemon can recognise as one of those — anything inside `.git/`, `.hg/` or `.svn/`; a shell startup
file; a `Makefile`, `justfile` or `.vscode/tasks.json`; a package manifest like `package.json` or
`Cargo.toml`; a CI config; `.pre-commit-config.yaml`, `.gitattributes` or `conftest.py`; or *any*
file being given an executable bit — stops and asks you, in this terminal or on the chat card,
naming the file and why. Approving one covers **that file**, never the whole root. Ordinary writes
are unaffected and still run without a prompt.

Know the limit of that, because it is a real one: **the list can never be complete.** A write to
ordinary source code that you later build or run is still a command, and no list of filenames
catches it. This raises the cost of the obvious attack and puts you in front of it; it is not a
boundary. Only operating-system sandboxing would be, and this daemon does not do that.

The `roots` in your policy file confine the paths an agent can **name** — the working directory it
asks for, and the files it asks to read or write. They do **not** confine what a program does once
it has started. A command approved with a working directory inside a root can still read
`/etc/passwd`, your SSH keys, or anything else your account can reach; it just cannot *ask* the
daemon to open them. Actually confining a running process needs operating-system sandboxing,
which this daemon does not do.

So the question at the prompt is not "may this touch that folder". It is "may this program, run
with any arguments, from any of my chats, run as me for the time I pick". Answer it the way you
would answer a stranger asking for your shell for the afternoon. Two practical consequences:

- Run the daemon as an ordinary user, never as root, and prefer a machine — or a separate account —
  that does not hold secrets you would not hand to whoever is driving the agent.
- `principals` is the list of PageSpace users allowed to drive this machine. Keep it short, and
  treat adding a name to it as the same decision as giving that person your shell.

What the daemon does guarantee is narrower than "safe", and worth knowing exactly:

- It **never listens on a port** — it dials out to PageSpace and nothing can dial in.
- It **denies by default**. No policy file, an unreadable one, or one anybody else can write means
  every request is refused.
- Every request carries a **server-signed grant** bound to that exact command or path list: it is
  single-use, expires within a minute, and cannot be replayed or edited in flight.
- Your policy is checked **after** the grant and independently of it. A request PageSpace considers
  allowed is still refused here if your policy does not allow it.
- Every decision — allowed, denied, declined — is appended to `~/.pagespace/env-audit.jsonl`.
- Revoking the environment in PageSpace **deletes this machine's key** and stops the daemon;
  Ctrl-C and `pagespace env disconnect` stop it too, and kill anything it started.

One consequence of the two facts above, worth seeing once before you pick a mode: an agent that
reads a file on this machine can be *steered* by what that file says — a README, a dependency's
source, a downloaded document can all contain text aimed at the agent rather than at you. If the
agent then runs a command whose program you have already approved, **that command runs without a
prompt** — with whatever arguments the steered agent chose. This is inherent to agents reading
content nobody vetted, not a defect in this daemon; the defences that apply here are the ordinary
ones — approve programs, not shells or interpreters, when you can; pick the shortest scope that
does the job; keep `principals` short and `ops` narrow; stop the daemon when you are not using it;
revoke approvals you no longer need; and read `~/.pagespace/env-audit.jsonl` when you want to
know what actually ran.

### The three modes, in practice

- **`deny`** — nothing runs, ever. The daemon still connects, so the Environment shows as connected.
- **`ask`** — the safe default to start with. An operation listed in `ops` runs without asking;
  anything else stops and prompts you in this terminal, showing the exact command, working
  directory, paths, environment and limits — and which programs an approval would cover. Approving
  remembers those programs (for you, on this environment) for the scope you pick; later commands
  that run only remembered programs are never shown to you, others ask. Declining refuses that
  request and asks again next time. Without a terminal (or with `PAGESPACE_ENV_ASK=chat`), the
  daemon does not deny: it freezes the exact request under a challenge and the question is put to
  you **in the PageSpace chat**, on a card showing that exact command, directory, environment and
  limits; the machine compares your click against what it froze before anything runs, and the
  challenge dies with the request's one-minute grant.
- **`allowlist`** — only the operations in `ops` run; everything else is denied with no prompt.

**`allowlist` allowlists operations, not executables.** `ops` holds `exec`, `fs_read` and
`fs_write` — so putting `exec` in it under `allowlist` mode means *any* command may run
unprompted, not some approved list of programs. There is deliberately no executable allowlist:
one was considered for this release and not adopted, because a list of program names is easy to
walk around (`sh -c …`, an interpreter, a script inside a root) and would suggest a guarantee the
daemon cannot keep. If you want per-command review, use `ask` and leave `exec` out of `ops`.
Because that one edit silently removes the click, the daemon is loud about it: `env connect` and
`env policy` print `exec is allowlisted: commands run on this machine without a click — remove
exec from ops to restore the approval prompt`, and `env connect` writes one audit line
(`policy_warning:exec_allowlisted`) at start.

A drive owner or admin creates a local Environment from the ordinary "New environment" step (choose
**This computer** and name the machine) and is shown a **one-time enrollment code** (valid ten
minutes, single use) beside these exact commands. Losing the code is not fatal: until a machine has
enrolled, the Environment's menu in the sidebar offers **Show a new code**, which replaces the old
one. Once a machine has enrolled, no new code can ever be issued for that Environment. On the machine:

```text
pagespace env enroll <enrollmentId> <code> [--host <url>]
pagespace env token <enrollmentId> [--host <url>]
pagespace env connect <enrollmentId> [--host <url>]
pagespace env disconnect <enrollmentId>
pagespace env policy [--json]
```

`env enroll` generates an Ed25519 keypair **on this machine**, sends the server the public half
with the code, and stores the private half — plus the server signing key it pinned in return — in
this machine's credential store under the profile `env:<enrollmentId>`. The private key is never
printed (not even with `--json`) and never leaves the machine. A refused enrollment discards the
key. `env token` proves possession of that key (the server issues a nonce, the machine signs it)
and prints a short-lived bridge token — the round trip `env connect` performs on every
reconnect. Neither command needs a login: the code, then the key, are the machine's credentials,
and the machine credential is never used to authenticate ordinary commands (`logout` and
`keys use` refuse it). The deployment must set `LOCAL_ENVS_ENABLED=true`; otherwise these
endpoints do not exist.

### `env connect` — the bridge daemon

`env connect` is the daemon that makes the Environment usable. It opens an **outbound** socket to
PageSpace (it never listens on a port), earns a fresh token from the machine key on every
(re)connect, sends a machine-signed `hello`, and then serves requests. Every request carries a
grant signed by the server key pinned at enrollment; the daemon verifies the signature, expiry,
env, single-use nonce and that the grant is bound to exactly this request **before** consulting
your policy, and runs nothing unless the policy allows it. Results are signed with the machine key
so the server can verify them. Everything is appended to `~/.pagespace/env-audit.jsonl`
(`PAGESPACE_ENV_AUDIT_LOG` to move it) as one JSON line per decision with the `grantId` the server
also audits — the server keeps one row per grant it signs or refuses (`drive_env_grant_audit`),
under the same id, and shows it to the Environment's owner as the machine's activity in
PageSpace. Ctrl-C, `env disconnect` (which signals the running daemon's pid from
`~/.pagespace/env-connect.<enrollmentId>.pid`), or a server-signed revoke stops it; a revoke also
deletes the machine key. After a server restart it reconnects with exponential backoff.

In this release the daemon serves `exec`, `fs_read` and `fs_write`; PTY sessions are advertised as
unsupported.

**Platform:** `env connect` runs on macOS and Linux only. It relies on POSIX process groups to
kill a timed-out command and on `O_NOFOLLOW` to open files safely, neither of which Windows
provides, so on Windows it refuses to start with a clear message. `env enroll`, `env token`,
`env disconnect` and `env policy` work everywhere.

**Transport:** the host must be `https://` (the daemon sends this machine's proof of possession
and a short-lived bearer token, and the socket is `wss://`). Plain `http://` is accepted only for
the loopback hosts used in local development (`localhost`, `127.0.0.1`, `::1`), matching the CLI's
OAuth loopback policy. Token redemption refuses to follow redirects.

**Stop, from PageSpace:** the Environment's owner can press **Stop** in PageSpace (the
Environment's settings, or their account's Local environments page). The server then refuses to
sign any grant for the Environment, and sends the daemon a server-signed `pause` frame — under its
own signing domain, so it can never be replayed as a revoke. On a verified pause the daemon
SIGKILLs every process group it started, forgets every request it had frozen for a click, writes
`paused:killed:<n>` to the audit log, answers with a machine-signed `pause_result` carrying that
count, and **stays connected** — the machine is not what is being stopped. **Resume** needs no
frame: grants simply sign again, and a click for a request frozen before the Stop matches nothing.
If the daemon was away when Stop was pressed, the pause is delivered on its next heartbeat.

**Stopping it:** `env connect` writes its process identity (pid, start time, `argv0`) to
`~/.pagespace/env-connect.<enrollmentId>.pid` and refreshes it periodically. `env disconnect`
validates that record — it must be ours, recent, and the process must still be alive — before
sending `SIGTERM`, and removes a stale file rather than risk signalling a reused pid.

### The policy file

The daemon reads `~/.pagespace/env-policy.json` (or the path in `PAGESPACE_ENV_POLICY`). **You**
own this file; PageSpace never sees or edits it. It must be owned by the user running `env connect`
and must not be writable by group or world (`chmod 600`) — otherwise it is ignored. **No policy file,
or one that is unreadable, invalid, wrongly owned or writable by others, means every request is
denied** (`no_policy`); the daemon still connects so you can see the Environment and fix the file.
`pagespace env policy` prints what is in force, or why the file is being ignored.

**`env enroll` writes a starter policy for you** if none exists: `mode: ask`, the **file**
operations the environment's server policy allows (`fs_read`, `fs_write`) pre-approved so file
work inside the root runs without asking — **never `exec`**, however the environment is
configured: every command reaches the prompt, and each program needs your approval the first time
— the directory you ran `enroll` in as the only root, and — the part that matters — `principals`
set to **your user id and nobody else's**. A machine is driven by its owner only: PageSpace will
only ever bind the environment owner's sessions to it, and this file makes the machine refuse
everyone else on its own, even if the server were wrong. An existing policy is never overwritten;
`enroll` prints the diff of what it would have written, and if the file does not name you it says so. Naming other users in `principals` is honoured (it is
your file), but `env policy` and `env connect` warn about it, because each user listed there can
run commands as you.

```json
{
  "mode": "ask",
  "principals": ["usr_01hzx…"],
  "ops": ["fs_read"],
  "roots": ["/Users/me/code/my-project"],
  "envAllowlist": ["CI", "NODE_ENV"],
  "maxBytes": 1048576,
  "maxTimeoutMs": 120000
}
```

- `mode` — see "The three modes, in practice" above. In short: `ask` prompts for anything not in
  `ops` and needs a TTY; `allowlist` runs only what is in `ops` and never prompts; `deny` runs
  nothing.
- `principals` — PageSpace user ids allowed to drive this machine. A request from anyone else is
  denied `principal_not_allowed`, whatever the server thinks. Each of these users can run commands
  as you on this machine, subject to `mode` and `ops`.
- `ops` — any of `exec`, `fs_read`, `fs_write` (`pty_open` is reserved for a later release). These
  are operation kinds, not programs: `exec` covers every command, and there is no per-executable
  allowlist.
- `roots` — absolute directories every working directory and every file path must resolve inside
  (symlinks are resolved; `..` is refused). Roots confine the paths an agent can *name*. They do
  not confine a command once it is running: an approved `exec` with its cwd inside a root still
  runs as you and can read anything you can read. See "What you are agreeing to" above. A root
  that is your **home directory** — or any directory above it — covers `~/.ssh`, your shell
  startup files and every project at once; `enroll`, `connect` and `pagespace env policy` all say
  so out loud, and honour it anyway: it is your machine. Name the project directories you meant.
- `envAllowlist` — environment variable names the server may set for a command. Loader and
  interpreter hooks (`LD_*`, `DYLD_*`, `PATH`, `NODE_OPTIONS`, …) are refused even if listed.
- `maxBytes` / `maxTimeoutMs` — caps on captured output and wall-clock per command; a request that
  asks for more is clamped, and a command that outlives its timeout has its whole process group
  killed. Both are optional (defaults 1 MiB and 120 s).

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

- **MCP client on this machine** — a name (`PAGESPACE_KEY`) only resolves against the OS
  keychain of the same machine and OS user that minted it, so this option requires the MCP
  client to run there too. Mint a key and reference it by name:
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
| `PAGESPACE_TIMEOUT_MS` | Request deadline in **milliseconds**; same precedence slot as `--timeout` (which takes seconds), and the way to raise it for `pagespace mcp`, which builds the same client. Unset leaves each operation on its own default. |
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
- **Credential safety:** no token is ever printed except behind the explicit `--show-token`
  opt-in — not in output, not in errors, not in logs. `--json` mode writes nothing to stdout but
  the JSON payload. Credentials live in the OS keychain (chmod-0600 file fallback); the
  active-key pointer is just a name, never a secret.
- **Pure core:** argv parsing, config resolution, and routing are pure functions over plain
  data. The pieces that must touch the outside world — the bin entrypoint, browser launching,
  and credential storage — are isolated behind injected interfaces rather than folded into the
  core; handlers receive an injected `{ sdk, stdout, stderr, env, credentialStore }` context,
  which is why the routing/parsing/resolution core is testable without a network.

## See also

- [`@pagespace/sdk`](https://github.com/2witstudios/PageSpace/tree/master/packages/sdk) — the
  typed client this CLI is a verb layer over.
- [PageSpace MCP integration docs](https://pagespace.ai/docs/integrations/mcp)
- [Agent access & isolation](https://github.com/2witstudios/PageSpace/blob/master/packages/cli/docs/agent-access.md)
- [Migrating from `pagespace-mcp`](https://github.com/2witstudios/PageSpace/blob/master/packages/cli/docs/migrating-from-pagespace-mcp.md)
- [CHANGELOG](https://github.com/2witstudios/PageSpace/blob/master/packages/cli/CHANGELOG.md)
