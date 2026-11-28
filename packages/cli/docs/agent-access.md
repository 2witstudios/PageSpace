# Agent access: what this CLI can and can't protect against

Tasks 1–5 of Phase 8 closed a real privilege-escalation path: minting a credential (`pagespace keys
create`) used to POST directly to the token-minting API with whatever ambient credential was on
hand, so a script or agent with shell access could mint itself a new, more powerful credential
unattended.
`pagespace mcp` used to fall back to your personal login if no credential was named explicitly.
Both of those are fixed — minting now requires a human in a browser approving a consent screen,
and `mcp` refuses to start without an explicit credential.

Neither of those fixes — nor anything else this CLI can do — stops an agent from *using* whatever
access it's already been handed. That's the boundary this document exists to state plainly.

## The trust boundary is the OS user, not the CLI

Every credential `pagespace` resolves — a stored key from `pagespace keys`, your `pagespace
login` credential, the `PAGESPACE_TOKEN` environment variable, or a `--token` flag — is, once
resolved, just bytes a process can read. A process with real shell access, running as the same OS
user as `pagespace`, can:

- Read `PAGESPACE_TOKEN` (or any other env var) out of its own environment or a parent process's.
- Read the credential store directly — the OS keychain, or the chmod-0600 file fallback — for
  every host and key that OS user has ever logged in or minted a token as.
- Pass `--key <name>` or `--token <value>` itself, for any key that store holds.

None of that is a bug in `pagespace`. A process running as your OS user can read what your OS user
can read; no CLI-level check changes that. If an agent has a shell, it has whatever credential
scope is reachable from that shell — full stop.

## What actually isolates an agent

Scoping a credential (`pagespace keys create --drive <id> --role member --name
agent`) limits *what* the credential can do if it's used maliciously or leaked. It does not limit
*who else* on the same machine can use it. The only thing that does is a process/filesystem
boundary underneath the CLI:

- **A dedicated OS user** that owns nothing but the agent's working directory and never has
  `pagespace login` run as it — so there's no personal credential on that account to escalate to.
- **A container or VM** scoped to the agent's task, so a compromised or over-permissioned agent
  can't read credentials or files belonging to anything else on the host.
- **A scoped token delivered only via environment variable** (`PAGESPACE_TOKEN`, set on that
  dedicated user/container/VM) — not `pagespace login`, which mints a long-lived personal
  credential meant for a human, and not a shared key also used outside that sandbox.

Put together: any agent with real bash/shell access should run as its own OS user (or inside its
own container/VM), and should receive exactly one scoped token, via `PAGESPACE_TOKEN`, and nothing
more. That combination — not the scope of the token alone — is the actual isolation boundary.

## What each auth path is for

| Path | Who it's for | What it grants |
| --- | --- | --- |
| `pagespace login` | You, personally, at an interactive prompt. | A `manage_keys`-scoped credential, for as long as it lives — lets you create/list/edit/revoke your own keys (including via `pagespace keys`), but zero content access on its own. |
| `pagespace keys` (guided wizard) or `pagespace keys create --drive <id> --role ... --name agent` (flag-driven) | An agent or automated process on this machine. | Only the drive(s)/role(s) named, stored under a key name separate from your personal login. |
| A raw `mcp_` token, from `pagespace keys create … --show-token` (printed exactly once, at mint time) or from **Settings → MCP** in the app | An agent, CI job, or service account on a *different* machine. | Whatever scope you pick when minting it. |

No command ever falls back to your personal login for content — it has no content access.
Content commands resolve, highest precedence first: `--token`/`--key` flags, then
`PAGESPACE_TOKEN`/`PAGESPACE_KEY` env, then this machine's **active key**, then a loud refusal.
`login`, `logout`, `whoami`, `help`, and the whole `keys` surface are exempt — each either mints
its own credential or only ever acts on your own account/keys. `pagespace mcp` is stricter:
the active key deliberately does not apply, so an MCP config must name its credential
explicitly and stays portable and self-describing — except on an AI agent's own machine, where
the stored login is the agent itself and the active key is the one it minted for itself
(`pagespace signup --agent`): there is no human credential there to ride.

## AI agents: create your own account

Everything above is about an agent borrowing a slice of a **human's** access. An AI agent can
instead hold an account of its own — no email, no browser, no human:

```bash
pagespace signup --agent --name "<your name>"
```

That creates the account (after a small proof-of-work), stores the agent's secret in the OS
keychain, mints the agent its own access key and makes it this machine's active key. The
content commands and `pagespace mcp` then act as the agent — the only identity on the machine —
in every drive the agent can reach and in no drive it cannot. Agents get no free AI credits:
`pagespace agent claim` prints a link for a human to approve, after which that human owns the
agent and pays for its AI usage. `pagespace login --agent` signs an existing agent in (secret on
stdin, never argv); `pagespace agent rotate-secret` replaces the secret. The isolation advice
above still applies: the agent's secret is a shared secret, so keep it inside the agent's own
OS user or container.

## What the active key changes (and doesn't)

`pagespace keys use <name>` makes one stored key the machine's ambient default after a browser
approval, so anything in your shell — you, scripts, coding agents driving the CLI in bash — can
run content commands without naming a credential. This changes the *ergonomics*, not the
boundary: as the list above shows, a same-OS-user process could already read the key store and
pass `--key` itself, so per-command explicitness was never a wall against a local agent. What
the browser approval actually gates is **changing which scope is ambient** — an agent in your
shell cannot activate a different, broader key on its own, exactly as it cannot mint or
re-scope one. Privilege *changes* (mint, edit, activate) require a human in a browser;
privilege *use* stays inside whatever scope the human activated; the OS user/container remains
the real isolation boundary.
