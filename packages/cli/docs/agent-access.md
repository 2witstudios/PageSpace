# Agent access: what this CLI can and can't protect against

Tasks 1–5 of Phase 8 closed a real privilege-escalation path: `pagespace tokens create` used to
POST directly to the token-minting API with whatever ambient credential was on hand, so a script
or agent with shell access could mint itself a new, more powerful credential unattended.
`pagespace mcp` used to fall back to your personal login if no credential was named explicitly.
Both of those are fixed — minting now requires a human in a browser approving a consent screen,
and `mcp` refuses to start without an explicit credential.

Neither of those fixes — nor anything else this CLI can do — stops an agent from *using* whatever
access it's already been handed. That's the boundary this document exists to state plainly.

## The trust boundary is the OS user, not the CLI

Every credential `pagespace` resolves — a stored profile from `pagespace login` or `pagespace
tokens create`, the `PAGESPACE_TOKEN` environment variable, or a `--token` flag — is, once
resolved, just bytes a process can read. A process with real shell access, running as the same OS
user as `pagespace`, can:

- Read `PAGESPACE_TOKEN` (or any other env var) out of its own environment or a parent process's.
- Read the credential store directly — the OS keychain, or the chmod-0600 file fallback — for
  every host and profile that OS user has ever logged in or minted a token as.
- Pass `--profile <name>` or `--token <value>` itself, for any profile that store holds.

None of that is a bug in `pagespace`. A process running as your OS user can read what your OS user
can read; no CLI-level check changes that. If an agent has a shell, it has whatever credential
scope is reachable from that shell — full stop.

## What actually isolates an agent

Scoping a credential (`pagespace tokens create --drive <id> --role member --save-as-profile
agent`) limits *what* the credential can do if it's used maliciously or leaked. It does not limit
*who else* on the same machine can use it. The only thing that does is a process/filesystem
boundary underneath the CLI:

- **A dedicated OS user** that owns nothing but the agent's working directory and never has
  `pagespace login` run as it — so there's no personal credential on that account to escalate to.
- **A container or VM** scoped to the agent's task, so a compromised or over-permissioned agent
  can't read credentials or files belonging to anything else on the host.
- **A scoped token delivered only via environment variable** (`PAGESPACE_TOKEN`, set on that
  dedicated user/container/VM) — not `pagespace login`, which mints a long-lived personal
  credential meant for a human, and not a shared profile also used outside that sandbox.

Put together: any agent with real bash/shell access should run as its own OS user (or inside its
own container/VM), and should receive exactly one scoped token, via `PAGESPACE_TOKEN`, and nothing
more. That combination — not the scope of the token alone — is the actual isolation boundary.

## What each auth path is for

| Path | Who it's for | What it grants |
| --- | --- | --- |
| `pagespace login` | You, personally, at an interactive prompt. | A `manage_keys`-scoped credential, for as long as it lives — lets you create/list/edit/revoke your own keys (including via `pagespace keys`), but zero content access on its own. |
| `pagespace keys` (or `pagespace tokens create --drive <id> --role ... --save-as-profile agent`) | An agent or automated process on this machine. | Only the drive(s)/role(s) named, stored under a profile separate from your personal login. |
| A token minted from **Settings → MCP** in the app | An agent, CI job, or service account on a *different* machine (there's no way to copy a `pagespace keys`/`tokens create` credential off the machine it was minted on). | Whatever scope you pick when minting it. |

Every non-exempt command never falls back to your personal login — it requires one of `--token`,
`PAGESPACE_TOKEN`, `--profile`, or `PAGESPACE_PROFILE` to be given explicitly. `login`, `logout`,
`whoami`, `help`, `tokens create`, and the whole `keys` surface (`keys`, `keys create`, `keys
list`, `keys revoke`) are exempt — each of those either mints its own credential or only ever
acts on your own account/keys, so there's nothing to fall back to. Every other command, including
`pagespace mcp` and `tokens list`/`tokens revoke`, fails loudly instead of silently running as you
if invoked with no explicit credential. This gate started as `pagespace mcp`-only (Phase 8); it
now applies CLI-wide (Phase 9).
