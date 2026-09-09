# Local Environment Bridge — Security Posture (Local Environments epic, GA)

**Status:** DRAFT FOR REVIEW — the internal record for the auditor, the DPO, the operator,
and the founder deciding whether to set `LOCAL_ENVS_ENABLED=true` in cloud. Written against
integration branch `pu/local-env-ga` at `18d98c06e` (waves 1 and 2 merged). Every claim below
names the file that makes it true; a claim the merged code does not yet make is marked
**PENDING (wave 3)** and must not be read as done. The customer-facing page
(`apps/marketing/src/app/docs/security/local-environments/page.tsx`) is derived from this
document and may not say anything this one does not.

Source records: epic page `j945few5ssv75k5ad0bowbb4` (the 13 invariants, decisions [D-1]–[D-6],
the Codex and OWASP reviews); plan `~/.claude/plans/elegant-stirring-crown.md` (review findings
1–6, quoted verbatim where marked).

## Context

A local environment is a computer the user owns — a laptop, a workstation, a server — enrolled
as a first-class PageSpace environment (`drive_envs.substrate = 'local'`,
`packages/db/src/schema/drive-envs.ts`) so that an agent session can read and write files and
run commands on it. A daemon on that computer (`pagespace env connect`,
`packages/cli/src/commands/env/connect.ts`) dials out to PageSpace over a WebSocket; PageSpace
sends signed requests; the daemon decides, runs, and signs the result.

**The mental model is SSH.** Enrolling a machine is installing an authorized key. The controls
that matter are the ones SSH has: who may connect, what the key may do, how fast it can be
revoked, and what the log shows. A per-command prompt is a speed bump, not a boundary; treating
it as the security story is what distorted the earlier design (plan, finding 1). This document
is organised around those four controls.

Everything described here is off unless the deployment sets `LOCAL_ENVS_ENABLED` to the exact
string `true` (`packages/lib/src/services/drive-envs/local-envs-enabled.ts`). The feature is
about to go to general availability in cloud; this is the record of what it is, what it
guarantees, and exactly where those guarantees stop.

## The claim we want, and the claim we can support

The claim we would like to publish:

> "Local Environments let an agent work on your own computer with the same safety as
> PageSpace's cloud sandbox: PageSpace can only ask, your machine decides, and nothing runs
> that you did not approve."

Every clause of that is partly true and none of it is fully true. The claim the merged code
supports:

> "A local environment is an authorized key you install on your own computer. PageSpace can
> request work on it and can never compel it: every request is signed for one operation and
> one set of arguments, expires within a minute, and is refused by your machine unless your
> own policy file allows it. Only the person who enrolled the machine can drive it; drive
> admins can delete and revoke it but never bind to it. Reading and writing files is confined
> to the folders you declared. **Running a command is not confined**: a command you approve
> runs as you, with your credentials and your network, and the approval is remembered per
> program, not per command line. There is no operating-system sandbox and no network egress
> control on your machine. PageSpace records every refusal to sign; per-request server-side
> audit rows, a live activity view and a Stop button are not yet shipped."

The rest of this document is the evidence for the second claim and the reasons the first
cannot be made.

## What is actually different from Claude Code, Codex, Cowork and computer use

The comparison the founder asked for, done honestly. Reproduced verbatim from the plan
(finding 2), including the verdict, because it is the sentence the customer page and the
flag-on decision both rest on.

> It is not "we have no sandbox." It is that five properties combine here that never all
> combine in the comparison tools:
>
> | Property | Claude Code | Codex | Cowork | Computer use | **This bridge** |
> |---|---|---|---|---|---|
> | Human present, watching | yes | yes | yes (live view) | yes | **no** — headless daemon, driven from a browser elsewhere |
> | OS confinement of exec | optional, off | **yes** (seatbelt / Landlock) | **yes** (isolated env, granted folders) | no | **no** ([D-1]) |
> | Egress control | no | yes (network off by default) | limited | no | **no** — the cloud sandbox has an allowlist; the local runner has nothing |
> | Who can drive it | the one user | the one user | the one user | the one user | **potentially other drive members** (`bindPolicy`), and other users' agents via agent-to-agent messaging |
> | Injection source | files in one repo | files in one repo | granted folders | screen | **every page, comment and message on a shared drive, written by anyone** |
> | Server as capability minter | model API only | model API only | model API only | model API only | **PageSpace signs the grants** |
>
> Computer use is "basically full permissions," as the founder says — but the human is at the
> screen. Claude Code without its sandbox is roughly this bridge's `exec`, **minus the person
> watching**. Cowork is the model worth copying: explicit scoped grants at setup, an isolated
> environment so it can run unattended, and a live view of what it is doing.
>
> **Verdict, stated for the posture document:** the feature is not fundamentally unsafe.
> File operations confined to declared roots are comparable to Cowork's folder grant without
> Cowork's isolation. **Unattended `exec` without a sandbox is materially less safe than Codex,
> roughly Claude Code minus the watching human, and more exposed than any of them on one vector
> none of them have** — a prompt injection on a shared page becoming arbitrary code on a
> teammate's laptop, with an open network and that teammate's credentials in the home
> directory.

Two cells of that table have moved since the plan was written, and the table is left as
written so the verdict is quoted rather than re-derived:

- **"Who can drive it."** Closed by [D-6]. `bindPolicy` is the single value `'owner'` in the
  type (`packages/lib/src/env-bridge/decide-bind.ts`), in the row CHECK
  (`packages/db/src/schema/drive-env-local.ts`, migration `packages/db/drizzle/0291_late_selene.sql`)
  and in the gate (`decideBind` has no actor role in its input at all). The bridge is now
  single-user on this axis, like the four comparison tools. Section "Owner-only binding" below
  says what this does and does not close.
- **"Egress control — the cloud sandbox has an allowlist."** The cloud sandbox no longer runs a
  named allowlist: both agent sandboxes and human terminals run open egress inside the microVM,
  with the boundary being the microVM's isolation and verified containment
  (`packages/lib/src/services/sandbox/network-options.ts`). The comparison for this bridge is
  therefore not "allowlist versus nothing" but "isolated VM with open egress versus the user's
  own machine with open egress and no isolation". The verdict is unchanged by this; if anything
  it is stronger, because the property the local runner lacks is the isolation, not the list.

## The trust boundary, and what [D-1] accepts

The boundary is stated in the CLI README (`packages/cli/README.md`, "What you are agreeing
to") in the words a user reads, and it is the same boundary this document describes:

> The `roots` in your policy file confine the paths an agent can **name** — the working
> directory it asks for, and the files it asks to read or write. They do **not** confine what
> a program does once it has started. A command approved with a working directory inside a
> root can still read `/etc/passwd`, your SSH keys, or anything else your account can reach;
> it just cannot *ask* the daemon to open them. Actually confining a running process needs
> operating-system sandboxing, which this daemon does not do.

The code says the same thing in the one place it would matter: `decideExecution` confines
every fs-op path and every cwd through `confinePath` (`packages/lib/src/env-bridge/decide-execution.ts`,
`packages/lib/src/env-bridge/confine-path.ts`) and states in its docblock that roots do not
sandbox what a command does once it runs. The runner spawns the resolved program with an
argument array, no shell, `detached: true`, and the scrubbed environment
(`packages/cli/src/env-bridge/exec-runner.ts`); it applies no seatbelt profile, no Landlock
ruleset, no namespace, and no network rule. There is nothing between the child process and the
user's account.

**What [D-1] accepts** (epic page, resolved 2026-09-07 and amended the same day): `exec` is
gated by policy, not confined by path. At the time of the decision the mitigation offered was
that the daemon shows the exact command before it runs; the amendment records that this held
only for the first command per op per session, because approvals were keyed on
`(userId, sessionId, op)`. **That specific defect is closed by wave 2**: approvals are now keyed
on `(envId, userId, op, subject)`, where the subject is the resolved program for `exec` or the
policy root for file operations (`packages/lib/src/env-bridge/decide-approval.ts`,
`packages/cli/src/env-bridge/approvals-store.ts`). The accepted risk now reads accurately as:
**one approval of a program grants execution of that program with any arguments, from any of
the owner's chats, as the owner, for the scope the owner chose (once, until the daemon stops,
30 days by default, or until revoked).** Approving `git status` covers `git push` tomorrow and
does not cover `rm`. A command line whose programs the lexer cannot pin down (`$(…)`, `eval`,
a nested `sh -c`, `find -exec`, `sudo`) yields no subject and is asked about every time
(`decide-approval.ts`, `shellCommandWords`).

## Deliberate setup is necessary, and not sufficient

This is the first of the two arguments the reader must leave with (plan, finding 3).

Deliberate setup — the one-time enrollment code shown once in the creation dialog
(`apps/web/src/components/agents/useSpawnSession.tsx`), the keypair generated on the machine
(`packages/cli/src/env-bridge/keypair.ts`), the policy file the enroller scaffolds with the
owner as the only principal and `exec` never pre-approved (`packages/cli/src/commands/env.ts`,
`scaffoldedPolicy`), the "Run commands" toggle off by default in the dialog
(`useSpawnSession.tsx`, `allowExec`) — bounds **who** may ask and **what** they may ask for,
at grant time.

It does not bound what an injected instruction does at **run** time. Those are two different
moments. For file operations inside roots the run-time blast radius is the roots themselves,
so deliberate setup is sufficient and file work may run headless (Tier A). For `exec` the
blast radius is the user's account, so deliberate setup alone leaves the cross-user injection
path open. That is why Cowork can be headless and Claude Code needs a watching human, and it is
why at GA **`exec` is never headless**: every command class needs the owner's click in the chat
(Tier B, next section).

## The layer that stands in for the sandbox

The second argument (plan, finding 4). The design is a three-way intersection: the machine
advertises an operation, PageSpace's server policy allows it, and the owner's policy file
allows it. When the plan was written none of the server half existed; wave 1 made it
load-bearing. The table below is the state of every layer **as of the merged code**, not as
designed.

| Layer | Where | Load-bearing at `18d98c06e`? |
|---|---|---|
| Cloud opt-in flag | `packages/lib/src/services/drive-envs/local-envs-enabled.ts`; consulted first in `decide-bind.ts`, `decide-sign.ts`, and each route in the next section | **Yes.** Off means the routes answer 404 and the socket closes 1008. |
| Code-execution kill-switch and tier gate | `packages/lib/src/services/sandbox/can-run-code.ts` (`CODE_EXECUTION_ENABLED`, payer tier, drive edit access); its result is an input to `decideBind` | **Yes**, for binding. A local env cannot widen what `canRunCode` refused. |
| Owner-only binding ([D-6]) | `packages/lib/src/env-bridge/decide-bind.ts`; assembled by `packages/lib/src/services/drive-envs/local-env-gate.ts`; called at spawn from `packages/lib/src/services/agent-workspaces/agent-workspaces.ts` (`substrate === 'local'` branch) via `apps/web/src/lib/drive-envs/drive-envs-runtime.ts` (`gateLocalEnvBind`) | **Yes.** Structural: `'owner'` is the whole set in type, CHECK and gate. |
| Server policy written at mint | `apps/web/src/app/api/drives/[driveId]/envs/route.ts` (POST, `serverPolicy` from the dialog); `packages/lib/src/services/drive-envs/drive-envs-store.ts`; column deny-by-default in `packages/db/src/schema/drive-env-local.ts` | **Yes.** |
| Server policy enforced at signing | `packages/lib/src/env-bridge/decide-sign.ts`, consulted in `EnvBridgeClient.sendGrant` (`apps/web/src/lib/env-bridge/bridge-client.ts`) **before** `signGrantFrame`; a refusal never touches the key and is written to the security audit log | **Yes.** This is the server's forced-command. The daemon's permissive constant is retired; the constant that remains (`packages/cli/src/env-bridge/dispatcher.ts`, `SERVER_POLICY_CARRIED_BY_SIGNATURE`) is documented as satisfied by the signature, not as a policy. |
| Server policy editable by the owner only | `apps/web/src/app/api/drives/[driveId]/envs/[envId]/route.ts` (PATCH); `setServerPolicy` is a compare-and-set on `(envId, ownerId, revokedAt IS NULL)` in `drive-envs-store.ts` | **Yes**, at the API. No settings UI calls it yet (wave 3). |
| Useless bind refused at bind time | `no_server_ops` last in `BIND_DENY_ORDER` (`decide-bind.ts`) | **Yes.** |
| Per-request signed grant, bound to the frame | `packages/lib/src/env-bridge/grant.ts` (`verifyGrant`: env, op, `argsHash`, TTL ≤ 60 s, skew, expiry, signature, nonce — in that order); `apps/web/src/lib/env-bridge/grant-signer.ts` (signs with the key the enrollment pinned); `packages/lib/src/env-bridge/grant-args.ts` (the one projection both sides hash) | **Yes.** |
| Replay refusal across daemon restarts | `packages/cli/src/env-bridge/nonce-store.ts` (`grantPredatesDaemon`) | **Yes.** |
| Machine-held identity and proof-of-possession tokens | `packages/cli/src/env-bridge/keypair.ts`; `packages/lib/src/env-bridge/challenge.ts`; `apps/web/src/app/api/env-bridge/token/route.ts` | **Yes.** The private key is generated on the machine and never printed or sent. |
| Socket bound to the enrollment | `apps/web/src/app/api/env-bridge/ws/route.ts` (token `resourceId` → `drive_env_local` row: enrolled, not revoked, owned by the token's user; hello verified under that row's pinned key) | **Yes.** |
| Outbound-only daemon | `packages/cli/src/env-bridge/ws-client.ts` (a grep test pins that nothing in the folder listens) | **Yes.** |
| Machine policy: principals, mode, ops, roots, env allowlist, caps | `packages/cli/src/env-bridge/policy.ts` (ownership and mode bits checked; anything untrustworthy is deny-all); `decide-execution.ts` | **Yes.** |
| Path confinement (file operations only) | `packages/lib/src/env-bridge/confine-path.ts`; `packages/cli/src/env-bridge/fs-runner.ts` (`O_NOFOLLOW`, `dev`/`ino` re-check on the open handle) | **Yes, for fs ops.** Not a sandbox for `exec`. |
| Environment scrubbing | `packages/lib/src/env-bridge/scrub-env.ts` (owner allowlist plus a hard-deny backstop); `exec-runner.ts` refuses to spawn with a hard-denied variable | **Yes.** |
| Owner's click on every `exec` class (Tier B) | `packages/cli/src/env-bridge/challenge-store.ts` (the machine freezes the exact request); `apps/web/src/lib/ai/tools/env-approval-tools.ts` (`request_env_approval`, injected only when the session is bound to a local env — `apps/web/src/lib/ai/core/local-env-binding.ts`); `apps/web/src/app/api/env-bridge/approvals/[challengeId]/route.ts` (the click, checked against `drive_env_local.ownerId`); `dispatcher.ts` (byte-compare against the frozen request before anything runs) | **Yes, as the default the enroller establishes — not as a rule the daemon enforces against its owner.** `scaffoldedPolicy` never writes `exec` into machine `ops`; but an owner who edits `exec` into `ops`, or runs `allowlist` mode with `exec`, is `preapproved_op` in `decideExecution` (`decide-execution.ts`, the `preapproved` branch) and runs with no challenge and no click. Honoured on purpose: the owner's machine, the owner's deliberate edit — the same principle wave 1 applied to a hand-edited `principals` list. A loud warning at `env connect` / `env policy` when `exec` is in machine `ops` is **PENDING (wave 3)**. Register entry R-11. Where the click applies, the authorization never passes through the model: it is an authenticated request, signed by the server as an `approvalIntent`, verified by the machine. |
| Durable approvals, machine-authoritative | `packages/cli/src/env-bridge/approvals-store.ts` (`~/.pagespace/env-approvals.json`, 0600, owner-only, re-read per decision); `decide-approval.ts` | **Yes.** The server can revoke one (`apps/web/src/app/api/drives/[driveId]/envs/[envId]/approvals/[approvalId]/route.ts`, over the signed revoke frame, 200 only on the machine's signed ack) and can never add one. |
| Machine-signed results | `packages/lib/src/env-bridge/machine-signatures.ts`; `apps/web/src/lib/env-bridge/result-verifier.ts`; an unverified result is never delivered | **Yes**, for `exec` and fs results and `grant_denied`. PTY frames are out of scope ([D-2], M2). |
| Revocation, server side | `packages/lib/src/services/drive-envs/local-env-revoke.ts` and `apps/web/src/lib/env-bridge/revoke.ts`: stamp `revokedAt` (CAS), revoke every `env:bridge` session, close the live socket 1008; `decideSign` and the token route refuse the enrollment from then on | **Yes, immediate and unconditional.** DELETE on a local env revokes the machine first (`envs/[envId]/route.ts`). |
| Revocation, machine side | the signed `revoke` frame (`revoke.ts`, `buildRevokeFrame`) is pushed only over a live socket **on this replica**; the daemon deletes its key on a verified frame (`ws-client.ts` reducer effect `deleteKey`); Ctrl-C and `env disconnect` kill every process group the daemon started (`exec-runner.ts`, `killAll`) | **Best-effort, and reported as such** (`notifyMachineOfRevoke` returns `no_live_socket` when the machine is offline or held by another replica). In that case the machine keeps an inert key: every reconnect is refused (`token/route.ts`, `revoked` → 410) and the daemon retries forever until stopped locally. The key is removed only by hand. |
| Audit, machine side | `packages/cli/src/env-bridge/audit-log.ts` (one JSON line per decision, keyed by `grantId`) | **Yes, but fail-open**: a failed write is swallowed and reported once to daemon stderr. Register entry R-1. |
| Audit, server side, per grant | `bridge-client.ts` writes a security-audit row for every **refusal** to sign (`onSignRefused`); a signed grant and its result are logged (`log().info`) but **no audit row is written** | **PENDING (wave 3)** — task `t3teevsx30jqvacj3powgvcj`. Until then the `grantId` join has one side. |
| Stop (pause grants without deleting) | `decide-sign.ts` reserves `paused` in its deny order; nothing sets it | **PENDING (wave 3)** — task `xv7v1fc1ulrvgt95jthf9o0j`. |
| Live activity view; settings pages | none on the branch | **PENDING (wave 3)** — tasks `pum3d9hbs4iy2tbu1yc9nbmj`, `zjcss63e97g524qcm1mh53lf`, `f3t9pbw8yhi2gathd0k6334j`. |
| Effective-capability display (`intersectCapabilities`) | `packages/lib/src/env-bridge/intersect-capabilities.ts` | **Not load-bearing.** Zero production callers on the branch; the three-way check runs inline in `decideExecution`. Informational only when the settings page lands. |
| OS confinement of `exec` | none | **Does not exist.** Post-GA task `bos8qmmwx4kkbx7v7huw3hhi`. |
| Egress control on the machine | none | **Does not exist.** Owned by the confinement task. |

In SSH terms, as of the merged code: the key is installed, there is a forced-command (the
server signs only allowed ops), the restricted shell is the owner's policy file plus the click,
and the server-side log records refusals but not yet what it granted.

## What `LOCAL_ENVS_ENABLED` exposes

With the flag off, none of the following exists: the routes answer `404 Not found`, the socket
is closed `1008 Not available`, `decideBind` and `decideSign` refuse `flag_disabled` before
evaluating anything else, and the creation dialog does not offer "This computer"
(`apps/web/src/app/api/ai/page-agents/multi-drive/route.ts` reports the flag to the client).
Boot refuses the flag without a signing key (`packages/lib/src/config/env-validation.ts`).
With the flag on, these surfaces exist:

1. **`POST /api/drives/[driveId]/envs` with `substrate: 'local'`**
   (`apps/web/src/app/api/drives/[driveId]/envs/route.ts`) — drive owner or admin creates the
   env, choosing `serverPolicy`; the creator becomes `ownerId`; returns the one-time enrollment
   code once.
2. **`POST /api/drives/[driveId]/envs/[envId]/enrollment-code`**
   (`.../enrollment-code/route.ts`) — a replacement code, only while no machine has enrolled;
   never after.
3. **`POST /api/env-bridge/enroll`** (`apps/web/src/app/api/env-bridge/enroll/route.ts`) —
   unauthenticated by design: the code is the credential. Pins the machine's public key,
   returns the server public key, `ownerId` and `serverPolicy`. Rate-limited, audited.
4. **`GET`/`POST /api/env-bridge/token`** (`.../token/route.ts`) — challenge, then
   proof-of-possession; mints a short-lived `env:bridge` token. Rate-limited per IP and per
   enrollment; every refusal audited.
5. **`GET`/`POST /api/env-bridge/approvals/[challengeId]`**
   (`.../approvals/[challengeId]/route.ts`) — the Tier B card reads the frozen request; the
   click answers it. Owner only (`drive_env_local.ownerId`); a drive admin is 403 `not_owner`,
   audited.
6. **`UPGRADE /api/env-bridge/ws`** (`.../ws/route.ts`) — the daemon's outbound socket. Token
   must be `env:bridge`, bound to this env, whose row is enrolled, unrevoked, and owned by the
   token's user; the first frame must be a `hello` verified under the pinned key.

Plus **the bind path**: a session spawn whose bound env is local runs `gateLocalEnvBind`
(`agent-workspaces.ts` → `drive-envs-runtime.ts` → `local-env-gate.ts` → `decideBind`), and
every tool call on it reaches the machine only through `sendGrant` (`bridge-client.ts`), which
runs `decideSign` first.

The approval-revoke route (`.../envs/[envId]/approvals/[approvalId]/route.ts`, DELETE) and the
env PATCH/DELETE routes are not flag-gated themselves; they act on rows that can only exist
when the flag was on, and they refuse a non-local env.

## Per-decision rationale

- **[D-1] `exec` is policy-gated, not path-confined.** Confining a running process is a
  runner-level sandbox, not a pure-core change; adopting it later is the post-GA confinement
  task. The cost is the verdict above. The amendment's specific defect is closed (approvals
  keyed on the program, not the session).
- **[D-2] PTY is a session-bound channel.** Open; M2 is out of scope for GA. Nothing in this
  document covers PTY frames.
- **[D-3] A local machine is a substrate of an environment**, created in the ordinary
  environment-creation flow; the dialog is the only place the enrollment code is shown.
- **[D-4] A global assistant cannot reach any environment.** Structural today
  (`drive_envs.driveId` is NOT NULL and a driveless session has no drive to match); deferred.
- **[D-5] A per-user "may my machines be used" setting.** Deferred; subsumed by the account
  settings page (wave 3).
- **[D-6] A machine is driven by its owner only.** Structural. It closes the multi-principal
  axis of the comparison. It does **not** close the cross-user injection path — see next.

## The two remaining risks

**1. Cross-user prompt injection reaching the machine.** Every page, comment and message on a
shared drive is written by other people, and the owner's own agent reads them. Owner-only
binding fixes who may *ask*; it does not fix what the owner's agent *read* before asking. An
instruction planted on a shared page can steer the owner's agent into requesting a command on
the owner's machine. **Mitigation: the owner's click on every `exec` class, in the chat**, on a
card showing the exact normalised command, working directory, environment and limits the
machine itself froze and signed (`challenge-store.ts`, `env-approval-tools.ts`,
`approvals/[challengeId]/route.ts`, `dispatcher.ts`). Two limits of that mitigation, stated
plainly: (a) once a program is approved, a later steered command that runs only approved
programs runs with no click, with whatever arguments the steered agent chose (the README says
this to the user; `decide-approval.ts` is the code); (b) the click asks the owner to judge a
command line, and a hostile command line can be made to look ordinary. Not a mitigation:
agent-human permission parity, because the owner can read the shared pages too. The injection
case is the one exit-gate test that proves the verdict rather than asserting it
(task `banj4poxtulz6g68ai42y666`).

**2. Open egress.** A command on the user's machine can reach anything that machine can reach,
with whatever credentials sit in the home directory. There is no mitigation on the machine
without confinement; `exec-runner.ts` spawns the process and applies no network rule.
**Accepted for GA**, with the Tier B click as the only control and the confinement task
(`bos8qmmwx4kkbx7v7huw3hhi`, seatbelt on macOS and Landlock on Linux, denying network except an
allowlist) as its owner. Until that lands, the README's advice is the control: run the daemon as
an ordinary user on a machine, or an account, that does not hold secrets you would not hand to
whoever is driving the agent.

## Rollout safety

- Off by default; the exact string `true` enables, and boot refuses the flag without
  `ENV_BRIDGE_SIGNING_KEY` or `ENV_BRIDGE_SIGNING_KEYS` (`env-validation.ts`).
- The flag is read per grant (`bridge-client.ts`, `flagEnabled`) and per request in every route,
  so flipping it off needs no restart to stop new work: every later grant is refused
  `flag_disabled` before signing, and no new socket is accepted. **A socket that is already
  open is not closed by the flip** (`ws/route.ts` checks the flag at upgrade only); it stays
  connected, receiving nothing, until it reconnects. Revoking the environment is the way to
  close a live socket now.
- Key rotation: grants and revokes are signed with the key the enrollment pinned
  (`grant-signer.ts`, `revoke.ts`); `ENV_BRIDGE_SIGNING_KEYS` holds current plus previous. A
  pinned key that is no longer loaded is a typed `signing_key_unavailable`, never a signature
  under another key.
- Local envs keep every Sprite column NULL under a CHECK
  (`packages/db/src/schema/drive-envs.ts`, `localNoSpriteCheck`), so they are structurally
  invisible to reclaim, storage-billing and egress predicates written for Sprites.
- Every layer fails closed: a missing sibling row is treated as revoked at bind and at signing;
  a policy the strict parser refuses is `null` and denies; an approvals file with any defect
  contributes nothing.

## Implementation status

- **Wave 1 — merged (#2582).** Server policy written at mint and enforced at signing; owner-only
  PATCH with a CAS; `no_server_ops` at bind; the daemon's permissive constant retired;
  `admins|members` removed structurally; enroller scaffolds `principals=[owner]`.
- **Wave 2 — merged (#2583).** Durable scoped approvals keyed `(envId, userId, op, subject)`;
  `decide-approval` matcher; enroller never allowlists `exec`; daemon challenge store;
  `request_env_approval` tool; owner-only click re-issues a grant with a signed
  `approvalIntent`; daemon byte-compares; server may only revoke an approval, and reports
  `revoked: true` only on the machine's signed ack.
- **Wave 3 — PENDING.** Server-side audit rows at sign and result time
  (`t3teevsx30jqvacj3powgvcj`); live activity panel (`pum3d9hbs4iy2tbu1yc9nbmj`); Stop
  (`xv7v1fc1ulrvgt95jthf9o0j`); drive settings `environments/` (`zjcss63e97g524qcm1mh53lf`);
  account settings `local-envs/` (`f3t9pbw8yhi2gathd0k6334j`); approval list route
  (`l591znd3socx6rweetwjtyc3` — the DELETE half exists on the branch).
- **Exit gate — PENDING.** Re-scope the P-family negatives and add the injection test
  (`banj4poxtulz6g68ai42y666`); run all 26 plus injection against a production build and record
  (`kwf7rgkes4q9olq3ytpou16w`; report on `ukqmwy41zkf192hwgh6sqsxf`).

## Residual-risk register

| # | Risk | Likelihood | Impact | Owner | Task |
|---|---|---|---|---|---|
| R-1 | **Fail-open daemon audit write.** `audit-log.ts` swallows a failed append and reports only the first failure ever, to the stderr of a long-running daemon nobody watches; commands keep running with no local record (invariants 10 and 12). | Low (disk full, permissions) | Medium: the machine-side half of the `grantId` join goes missing silently | CLI daemon | `nn1j0oto0kyobukvb75lzjqo` (page `ko4jaad5qdeyc3yp5fjdpe4f`) |
| R-2 | **No server-side audit row per grant.** Only refusals to sign are audited; a signed grant and its result are logged, not audited. The join the README promises the user has one side. | Certain until wave 3 | Medium: no operator-side record of what ran | apps/web | `t3teevsx30jqvacj3powgvcj` |
| R-3 | **No OS confinement of `exec`.** A command runs as the user with the user's files, credentials and network. This is the verdict's "less safe than Codex". | Certain by design ([D-1]) | High | Post-GA | `bos8qmmwx4kkbx7v7huw3hhi` |
| R-4 | **Open egress.** No network control on the machine. Exfiltration bounded only by the click and by what the owner keeps on that machine. | Certain by design | High | Post-GA (with R-3) | `bos8qmmwx4kkbx7v7huw3hhi` |
| R-5 | **Approval scope is the program, not the command line.** An approved program runs with any arguments, from any of the owner's chats, for up to 30 days by default; a steered agent needs no click for it. Interpreters and shells approved as programs widen this to everything. | Medium | High | CLI daemon / pure core | `ux594fzl6w6rydlvhz2hsndq` (recorded superseded by the re-key, page `xylo4nv27udrajb21aws6p3u`; the program-level residual stays open here) |
| R-6 | **Cross-user prompt injection.** Shared-drive content steers the owner's agent into asking for a command; owner-only binding does not close this. | Medium on any shared drive | High | Product (Tier B click) + exit gate | `banj4poxtulz6g68ai42y666` (injection test) |
| R-7 | **No Stop.** Pausing an environment's grants without deleting it does not exist; the only kill switches are revoke (destructive, the machine deletes its key) and stopping the daemon locally. | Certain until wave 3 | Medium | apps/web | `xv7v1fc1ulrvgt95jthf9o0j` |
| R-8 | **Re-enrol after revoke.** A revoked env cannot take a new machine (`enrollment-code/route.ts` answers 410 and says to delete and recreate); the server policy goes with the row, and approvals on the machine are keyed to the old env id so they no longer apply. | Low | Low (usability; no security loss) | Follow-up | page `m3cqduvg8pfl9zi7hn3okouf` |
| R-9 | **Unattended daemon.** The daemon is a terminal process today; making it a service (post-GA) deepens the unattended property that Tier B exists for. | — | — | Post-GA, after activity panel and Stop | page `h083wifv1p56fytihplpkf6p` |
| R-11 | **Owner-disabled exec click.** An owner who edits `exec` into machine `ops` (or runs `allowlist` with `exec`) turns the Tier B click off for that machine; every command then runs unprompted as the owner. Honoured by design (owner's machine, deliberate edit). | Low | High | The owner | Mitigation: a connect-time and `env policy` warning when `exec` is in machine ops — **PENDING (wave 3)** until it lands |
| R-10 | **Exit gate not yet re-run.** Several P-family negatives assumed server refusals that only exist since wave 1; the 26 negatives and the injection test have not been run on the GA build. | Certain until run | High: the verdict is asserted, not proven | Point guard | `banj4poxtulz6g68ai42y666`, `kwf7rgkes4q9olq3ytpou16w` |

## Flag-on checklist

Each item is a command whose output is the evidence, or a task that must read Done. Run from
the repository root on the commit being deployed.

1. Wave 3 merged: tasks `t3teevsx30jqvacj3powgvcj` and `xv7v1fc1ulrvgt95jthf9o0j` are Done, and
   `grep -n "paused" apps/web/src/lib/env-bridge/bridge-client.ts` shows the Stop flag fed
   into `decideSign`.
2. Exit gate recorded: tasks `banj4poxtulz6g68ai42y666` and `kwf7rgkes4q9olq3ytpou16w` are Done
   with the report on `ukqmwy41zkf192hwgh6sqsxf`.
3. Migration 0291 applied on the target database:
   `psql "$DATABASE_URL" -c "\d drive_env_local" | grep bind_policy_check` shows
   `CHECK ("bindPolicy" IN ('owner'))`.
4. Signing key present on `pagespace-web`:
   `fly secrets list -a pagespace-web | grep -E 'ENV_BRIDGE_SIGNING_KEYS?'` (digest only; never
   print the value).
5. Code execution enabled, or nothing can bind:
   `fly ssh console -a pagespace-web -C "printenv CODE_EXECUTION_ENABLED"` prints `true`
   (`can-run-code.ts`).
6. Boot check passes with the flag: `LOCAL_ENVS_ENABLED=true` and a signing key set together
   (`packages/lib/src/config/env-validation.ts`); confirm the app starts.
7. Every file cited in this document exists on the deployed commit:
   `for f in $(grep -oE '\`(apps|packages)/[^\`]+\.(ts|tsx|sql|md)\`' docs/security/local-environment-bridge.md | tr -d '\`' | sort -u); do test -f "$f" || echo "MISSING $f"; done`
   prints nothing.
8. Flag off is really off, before turning it on:
   `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<host>/api/env-bridge/enroll -d '{}'`
   prints `404`.
9. The customer page is live and says nothing this document does not:
   `curl -s -o /dev/null -w '%{http_code}\n' https://pagespace.ai/docs/security/local-environments`
   prints `200`.
10. Set `LOCAL_ENVS_ENABLED=true`; then repeat item 8 and expect `400` (the route now exists and
    rejects an empty body), and enrol one machine end to end per the README.

## Out of scope

- **PTY sessions (M2).** `pty_open` is advertised unsupported by the daemon
  (`dispatcher.ts`, `DAEMON_CAPABILITIES`); the PTY frame model needs [D-2].
- **Consumers (M3).** PanePicker and the `pagespace pane` viewer.
- **Global assistant ([D-4]).** A driveless session cannot bind any environment; changing that
  is its own task with its own tests.
- **Windows.** `env connect` refuses to start there (`packages/cli/src/commands/env/connect.ts`).
