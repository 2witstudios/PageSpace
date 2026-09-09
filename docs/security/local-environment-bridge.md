# Local Environment Bridge — Security Posture (Local Environments epic, GA)

**Status:** DRAFT FOR REVIEW — the internal record for the auditor, the DPO, the operator,
and the founder deciding whether to set `LOCAL_ENVS_ENABLED=true` in cloud. Written against
integration branch `pu/local-env-ga` at `ea7357bb0` (waves 1, 2 and 3 merged). Every claim below
names the file that makes it true; a claim the merged code does not yet make is marked
**PENDING** and must not be read as done. The only PENDING work left is the exit gate. The customer-facing page
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
> control on your machine. Every request PageSpace signs, and every one it refuses, is recorded
> on the server under the same id the machine writes to its own log, and a request that cannot
> be recorded is not sent. The owner sees that record live and can Stop the machine, which kills
> what it is already running — and PageSpace calls it stopped only on the machine's own
> signature."

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
| Path confinement (file operations only) | `packages/lib/src/env-bridge/confine-path.ts`; `packages/cli/src/env-bridge/path-probe.ts` (the injected `realpath`/`isSymlink` probe, and `createStatMode` beside it); `packages/cli/src/env-bridge/fs-runner.ts` (`O_NOFOLLOW`, `dev`/`ino` re-check on the open handle) | **Yes, for fs ops.** Not a sandbox for `exec`. |
| Sensitive-write escalation (Tier A is not a free pass) | `packages/lib/src/env-bridge/classify-write.ts` (the pure classifier and its seven reasons); called from `packages/lib/src/env-bridge/decide-execution.ts` on the CONFINED paths, before the `preapproved` short-circuit; the file-level approval subject in `packages/lib/src/env-bridge/decide-approval.ts` (`file:<path>`); the mode threaded into the decision by `grant-args.ts` (`writeModes`, inside `canonicalizeArgs`); rendered by `apps/web/src/components/ai/shared/chat/env-approval/EnvApprovalCard.tsx` and `packages/cli/src/env-bridge/ask.ts` | **Yes, and it is what makes the two tiers hold at all.** Confinement answers WHERE a write lands, never WHAT it says: before this, an injected page could have the owner's own agent write `.git/hooks/pre-commit` mode `0o755` inside a declared root, headless, and the next `git commit` ran it as the owner — bypassing the Tier B click entirely. A recognised write is now an **ask**, never a deny, so ordinary writes still run headless and a false positive costs one click; approving one covers that FILE, not the root. The executable question is asked of the **resulting** mode, not the requested one (Codex P1 on the first cut): `fs-runner.ts` chmods only when the request names a mode, so a mode-less overwrite of an already-executable `bin/tool` used to stay Tier A and replace a command that later runs as the owner. The existing mode comes from an injected `statMode` probe (`packages/cli/src/env-bridge/path-probe.ts`, `createStatMode`), called only for `fs_write`, only after confinement, and only for a path whose write names no mode — so it always runs on a resolved real path inside a root; it throws nothing (any error reads as "no existing file"), and `decideExecution` memoises it so the escalation and the approval subject cannot disagree about one request. **Its limit is real and is not a detail** — see R-13: the list can never be complete, and a write to ordinary source the owner later builds is still execution. |
| Write-mode and file-count limits | `packages/lib/src/env-bridge/frame-codec.ts` (`fileMode` masks to `0o777`; `MAX_FS_WRITE_FILES`) | **Yes.** setuid, setgid and the sticky bit are refused at decode rather than escalated — not something to put in front of an owner in a chat card — and one write grant cannot carry more files than a person can read. `0o755` decodes and is escalated by the classifier instead. |
| Environment scrubbing | `packages/lib/src/env-bridge/scrub-env.ts` (owner allowlist plus a hard-deny backstop); `exec-runner.ts` refuses to spawn with a hard-denied variable | **Yes.** |
| Owner's click on every `exec` class (Tier B) | `packages/cli/src/env-bridge/challenge-store.ts` (the machine freezes the exact request); `apps/web/src/lib/ai/tools/env-approval-tools.ts` (`request_env_approval`, injected only when the session is bound to a local env — `apps/web/src/lib/ai/core/local-env-binding.ts`); `apps/web/src/app/api/env-bridge/approvals/[challengeId]/route.ts` (the click, checked against `drive_env_local.ownerId`); `dispatcher.ts` (byte-compare against the frozen request before anything runs) | **Yes, as the default the enroller establishes — not as a rule the daemon enforces against its owner.** `scaffoldedPolicy` never writes `exec` into machine `ops`; but an owner who edits `exec` into `ops`, or runs `allowlist` mode with `exec`, is `preapproved_op` in `decideExecution` (`decide-execution.ts`, the `preapproved` branch) and runs with no challenge and no click. Honoured on purpose: the owner's machine, the owner's deliberate edit — the same principle wave 1 applied to a hand-edited `principals` list. A loud warning at `env connect` / `env policy` when `exec` is in machine `ops` is **PENDING (wave 3)**. Register entry R-11. Where the click applies, the authorization never passes through the model: it is an authenticated request, signed by the server as an `approvalIntent`, verified by the machine. |
| Durable approvals, machine-authoritative | `packages/cli/src/env-bridge/approvals-store.ts` (`~/.pagespace/env-approvals.json`, 0600, owner-only, re-read per decision); `decide-approval.ts` | **Yes.** The server can revoke one (`apps/web/src/app/api/drives/[driveId]/envs/[envId]/approvals/[approvalId]/route.ts`, over the signed revoke frame, 200 only on the machine's signed ack) and can never add one. |
| Machine-signed results | `packages/lib/src/env-bridge/machine-signatures.ts`; `apps/web/src/lib/env-bridge/result-verifier.ts`; an unverified result is never delivered | **Yes**, for `exec` and fs results and `grant_denied`. PTY frames are out of scope ([D-2], M2). |
| Revocation, server side | `packages/lib/src/services/drive-envs/local-env-revoke.ts` and `apps/web/src/lib/env-bridge/revoke.ts`: stamp `revokedAt` (CAS), revoke every `env:bridge` session, close the live socket 1008; `decideSign` and the token route refuse the enrollment from then on | **Yes, immediate and unconditional.** DELETE on a local env revokes the machine first (`envs/[envId]/route.ts`). |
| Revocation, machine side | the signed `revoke` frame (`revoke.ts`, `buildRevokeFrame`) is pushed only over a live socket **on this replica**; the daemon deletes its key on a verified frame (`ws-client.ts` reducer effect `deleteKey`); Ctrl-C and `env disconnect` kill every process group the daemon started (`exec-runner.ts`, `killAll`) | **Best-effort, and reported as such** (`notifyMachineOfRevoke` returns `no_live_socket` when the machine is offline or held by another replica). In that case the machine keeps an inert key: every reconnect is refused (`token/route.ts`, `revoked` → 410) and the daemon retries forever until stopped locally. The key is removed only by hand. |
| Audit, machine side | `packages/cli/src/env-bridge/audit-log.ts` (one JSON line per decision, keyed by `grantId`, and — since hardening A — naming the file paths an fs op touched: the confined real paths on an allow, the requested ones on a refusal) | **Yes, but fail-open**: a failed write is swallowed and reported once to daemon stderr. Register entry R-1. |
| Audit, server side, per grant | `packages/db/src/schema/drive-env-grant-audit.ts` (its own table, not the hash-chained log, because a row is written at sign and UPDATED at result); `packages/lib/src/services/drive-envs/grant-audit-store.ts`; written by `bridge-client.ts` (`recordSign` before the frame goes out, `recordRefusal`, `recordResult`) | **Yes, and fail-CLOSED at sign time.** A sign-time row that cannot be written throws `audit_unavailable` and **the grant is never sent** (`bridge-client.ts`, the `recordSign` try/catch: "Grant audit row could not be written; grant NOT sent"). The result-time update cannot un-run anything, so its failure is logged and the row stays `signed`. `resultAt IS NULL` on a signed row is exactly "running now". The `grantId` join now has both sides. |
| Stop / Resume | `PATCH .../envs/[envId]` with `{ paused }`, env owner only (`apps/web/src/app/api/drives/[driveId]/envs/[envId]/route.ts`); `setEnvPaused` stamps `pausedAt`, which `decide-sign.ts` now consumes as its reserved `paused` deny; `apps/web/src/lib/env-bridge/pause.ts` signs a `pause` frame under its OWN domain (`pause/v1`, over `{envId, enrollmentId, keyId, issuedAt, pausedAt}`) so it can never be replayed as a revoke; the daemon kills every process group it started, drops every pending challenge, and acks with a machine-signed `pause_result { envId, pausedAt, killed }` (`packages/cli/src/env-bridge/dispatcher.ts`) | **Yes.** The daemon also latches: `pausedAt` is recorded before anything is killed and every grant whose `iat` is at or before it is refused `paused`, re-checked after every await and immediately before any runner (`dispatcher.ts`, `predatesPause`). A grant issued after the pause is itself the proof of Resume. **Limit:** a Stop issued on a replica that does not hold the socket returns `no_live_socket` and is re-sent by the holding replica on its next heartbeat, so a cross-replica Stop is bounded by one ping interval (`ENV_BRIDGE_PING_INTERVAL_MS`, 30 s); and an unacknowledged send is reported as unacknowledged, never as stopped. |
| Live activity view | `apps/web/src/lib/websocket/env-activity-events.ts` — one `env:activity` event per audit row, at sign and again at result, fanned out to exactly ONE room: `user:<ownerId>:sessions`. Read routes `GET .../envs/[envId]/activity` and `GET /api/env-bridge/activity`, both owner-only by the row; UI in `apps/web/src/components/agents/EnvActivityPanel.tsx` | **Yes.** The payload names a command (`summary`), so the audience is the machine's owner and no drive room ever — the live feed is deliberately no wider than the owner-only read. |
| Settings surface | Drive settings → Environments (`apps/web/src/app/dashboard/[driveId]/settings/environments/page.tsx`, the page a `no_server_ops` refusal points at: status, the three switches, effective capability, activity, Stop/Resume, Revoke); Account → Local environments (`apps/web/src/app/settings/local-envs/page.tsx`): every machine the caller owns across every drive, its activity, and every approval in force, each revocable | **Yes.** The account routes (`GET /api/env-bridge/machines`, `/approvals`, `/activity`) are owner-only *by construction* — they select on `drive_env_local.ownerId = caller` and take no id to check. This is [D-5] subsumed. |
| Approval mirror and the revoke that cannot be lost | `packages/db/src/schema/drive-env-approvals.ts`, `packages/lib/src/services/drive-envs/approval-mirror-store.ts` (visibility and revocation only — a source-scan test pins that nothing here can send an approval TO a machine); an owner's revoke is `revokePending` until the machine's SIGNED ack, and `listUnacknowledgedRevokes` is replayed on the daemon's next hello before any grant for that env is signed (`ws/route.ts`) | **Yes, and it BLOCKS.** While a replay leaves a revoke unacknowledged the env is refused every grant, typed `revoke_pending` (`bridge-client.ts`), so the window in which a machine still holds what the owner revoked is never a window in which it is asked to use it. |
| Session approvals die with the process | `daemonEpoch` — a random id per daemon PROCESS, attested inside the signed `hello` bytes (`packages/lib/src/env-bridge/machine-signatures.ts`, `frame-codec.ts`); `expireSessionEnvApprovalsForOtherEpoch` on hello (`ws/route.ts`) | **Yes.** A restart changes the epoch and expires every session-scoped approval the mirror held for the old one; a reconnect does not. |
| The exec-allowlisted warning ([D-7]) | `packages/lib/src/env-bridge/policy-warnings.ts` (`exec_allowlisted`), printed by `env connect` (and audited there as `policy_warning:exec_allowlisted`) and by `env policy` | **Yes, for `allowlist` mode.** See R-11: the warning fires on `mode === 'allowlist' && ops.includes('exec')`, but `decideExecution` treats `exec` in `ops` as pre-approved **in `ask` mode too** (`decide-execution.ts`, `preapproved`), and that combination is not warned about. |
| The home-root warning | `packages/lib/src/env-bridge/policy-warnings.ts` (`root_is_home`), printed by `pagespace env enroll` (while the owner is at the keyboard), `env connect` and `env policy`, and audited at connect as `policy_warning:root_is_home` | **Loud, never refusing** — the same [D-7] principle. `enroll` scaffolds `roots: [cwd]` and `policy-types.ts` refuses only `/` and `..`, so enrolling from `$HOME` silently scopes an agent to `~/.ssh`, the shell rc files and every project at once, with no click (file ops are Tier A). `connect` now audits every warning CODE rather than special-casing one. |
| Effective-capability display (`intersectCapabilities`) | `packages/lib/src/env-bridge/intersect-capabilities.ts`, shown on the drive settings Environments page | **Informational, never load-bearing.** The enforcing three-way check runs inline in `decideExecution`; this is the display of it, and the page states the machine's own policy file as unknown to the server. |
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

## Wire-protocol note (wave 3)

The signed `hello` now **requires** `daemonEpoch` (`frame-codec.ts`: the field is
non-optional in the schema, and `machine-signatures.ts` folds it into the signed bytes). A
daemon built before wave 3 does not send it, so its hello fails to decode and it **cannot
connect**. This is a breaking protocol change with no negotiation and no version fallback.
It is acceptable only because `LOCAL_ENVS_ENABLED` is off in every deployment, so no
enrolled machine exists anywhere to break; it would not be acceptable after GA. Once the
flag is on, any later change to the hello bytes needs a version field and a migration path.

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
command line, and a hostile command line can be made to look ordinary; and (c) an owner who
puts `exec` in their machine `ops` removes the click for that machine entirely, which [D-7]'s
warning announces in `allowlist` mode but not in `ask` mode. A fourth
limit is now closed at its worst point and stated as R-13: the same injected page used to be able
to skip the click entirely by asking for a FILE write — `.git/hooks/pre-commit`, mode `0o755`,
inside a declared root — which the owner's next `git commit` then ran. A recognisable write of
that kind is now escalated to the same card (`classify-write.ts`), naming the file and the
reason; a write to ordinary source the owner later builds still is not, and cannot be. Not a
mitigation: agent-human permission parity, because the owner can read the shared pages too. The injection
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
- **Wave 3 — merged (#2585, `ea7357bb0`).** `drive_env_grant_audit` written at sign (fail-closed:
  no row, no grant) and updated at result; live activity to the owner's room only; Stop and
  Resume, signed under their own domain, killing process groups on the machine and acked with a
  signed `pause_result`, with a daemon-side latch refusing every grant issued at or before the
  pause; drive settings → Environments and account → Local environments, with owner-scoped
  account routes; the approval mirror with `revokePending` and a reconnect replay that BLOCKS
  the env (typed `revoke_pending`) until the machine acks; session approvals tied to a signed
  `daemonEpoch`; the exec-allowlisted warning ([D-7]). GDPR export gains
  `local-environment-activity.json` and `local-environment-approvals.json`
  (`packages/lib/src/compliance/export/gdpr-export.ts`).
- **Exit gate — RUN, 2026-09-09. 40 checks, 40 PASS, 0 SKIP.** Re-scoped row by row against the
  merged code (several rows asserted refusals that only exist since wave 1, and several could not
  fire in the shape the page described), then run against a **production standalone build of this
  branch** with a real UTC Postgres, the CLI built from this tree driving a real enrolled machine,
  and a real browser for every click. Report on `ukqmwy41zkf192hwgh6sqsxf`; harness and re-scope
  table in `scripts/env-bridge-exit-gate/`. Both leaf tasks
  (`banj4poxtulz6g68ai42y666`, `kwf7rgkes4q9olq3ytpou16w`) are Done.
  **The injection case passes**, in both arms: the model declined the injected `curl … | sh` when
  it met it unprompted, and — the arm that proves the mechanism rather than the model — when the
  agent was asked to run the page's command, the machine froze it under a challenge, the card
  rendered the literal command, and the daemon's audit for that run carried one `ask_pending` and
  **zero** `allow` lines. The run found one defect, fixed on this branch: a `DELETE` refused
  `409 live_sessions` had already revoked the machine (`llb2x2c5rew97nxg9xkio7u1`; register R-12).

## Residual-risk register

| # | Risk | Likelihood | Impact | Owner | Task |
|---|---|---|---|---|---|
| R-1 | **Fail-open daemon audit write.** `audit-log.ts` swallows a failed append and reports only the first failure ever, to the stderr of a long-running daemon nobody watches; commands keep running with no local record (invariants 10 and 12). | Low (disk full, permissions) | Medium: the machine-side half of the `grantId` join goes missing silently | CLI daemon | `nn1j0oto0kyobukvb75lzjqo` (page `ko4jaad5qdeyc3yp5fjdpe4f`) |
| R-2 | **CLOSED (wave 3).** `drive_env_grant_audit` carries a row per signed grant and per refusal, updated at result time, and the sign-time write fails CLOSED — no row, no grant (`bridge-client.ts`). The `grantId` join has both sides. *Residual:* the result-time update is best-effort, so a row can stay `signed` after the work finished if that update fails; "running now" can over-report, never under-report. | — | — | Closed | #2585 |
| R-3 | **No OS confinement of `exec`.** A command runs as the user with the user's files, credentials and network. This is the verdict's "less safe than Codex". | Certain by design ([D-1]) | High | Post-GA | `bos8qmmwx4kkbx7v7huw3hhi` |
| R-4 | **Open egress.** No network control on the machine. Exfiltration bounded only by the click and by what the owner keeps on that machine. | Certain by design | High | Post-GA (with R-3) | `bos8qmmwx4kkbx7v7huw3hhi` |
| R-5 | **Approval scope is the program, not the command line.** An approved program runs with any arguments, from any of the owner's chats, for up to 30 days by default; a steered agent needs no click for it. Interpreters and shells approved as programs widen this to everything. | Medium | High | CLI daemon / pure core | `ux594fzl6w6rydlvhz2hsndq` (recorded superseded by the re-key, page `xylo4nv27udrajb21aws6p3u`; the program-level residual stays open here) |
| R-6 | **Cross-user prompt injection.** Shared-drive content steers the owner's agent into asking for a command; owner-only binding does not close this. | Medium on any shared drive | High | Product (Tier B click) + exit gate | `banj4poxtulz6g68ai42y666` (injection test) |
| R-7 | **CLOSED (wave 3), with one bound.** Stop pauses the env (server signs nothing more), kills the machine's running process groups, and is reported stopped only on the machine's signed `pause_result`; the daemon latch refuses grants issued at or before the pause. *Residual:* a Stop issued on a replica that does not hold the socket is delivered by the holding replica on its next heartbeat, so worst-case delivery is one 30 s ping interval, and an unacknowledged send says so rather than claiming the machine stopped. | Low | Medium | apps/web | #2585 |
| R-8 | **Re-enrol after revoke.** A revoked env cannot take a new machine (`enrollment-code/route.ts` answers 410 and says to delete and recreate); the server policy goes with the row, and approvals on the machine are keyed to the old env id so they no longer apply. | Low | Low (usability; no security loss) | Follow-up | page `m3cqduvg8pfl9zi7hn3okouf` |
| R-9 | **Unattended daemon.** The daemon is a terminal process today; making it a service (post-GA) deepens the unattended property that Tier B exists for. | — | — | Post-GA, after activity panel and Stop | page `h083wifv1p56fytihplpkf6p` |
| R-11 | **Owner-disabled exec click — mitigation partly shipped.** An owner who edits `exec` into machine `ops` turns the Tier B click off for that machine; every command then runs unprompted as the owner. Honoured by design (owner's machine, deliberate edit). [D-7] now prints a loud warning at `env connect` (audited `policy_warning:exec_allowlisted`) and `env policy` — **but only for `mode: 'allowlist'`**. `decideExecution` treats `exec` in `ops` as pre-approved in `ask` mode too, and that combination is NOT warned about. | Low | High | The owner; the warning gap is a follow-up | Warning shipped #2585 (`policy-warnings.ts`); `ask`-mode gap open |
| R-10 | **CLOSED (2026-09-09).** The gate was re-scoped against the merged code and run on a production build of this branch: 40 checks, 40 PASS, 0 SKIP, including both arms of the injection case. The verdict is proven, not asserted. | — | — | — | `ukqmwy41zkf192hwgh6sqsxf` (report), `banj4poxtulz6g68ai42y666`, `kwf7rgkes4q9olq3ytpou16w` (Done) |
| R-12 | **A destructive side effect on a REFUSED request.** This feature pairs a guard with an irreversible REMOTE effect in four places — env revoke, env delete, Stop, and approval revoke — and the effect is a signed frame that changes state on someone's computer (a deleted key, a SIGKILLed process group, a forgotten approval). Where the guard is evaluated beside the effect rather than with it, a refusal the caller reads as "nothing happened" can leave the machine changed and unrecoverable: `DELETE …/envs/[envId]` did exactly that until 2026-09-09, revoking the machine and every session before the `409 live_sessions` guard had a say, and per R-8 the surviving row could then never take a new machine. Structural, not a slip: the irreversible half is remote and cannot be rolled back with the transaction. | Was certain on that route; now guarded | High — silent, and unrecoverable without re-enrolment | The env routes | **Mitigated**: the effect runs as the delete transaction's `beforeDelete`, under the row lock, after the guard passes, so guard and effect are one critical section (`drive-envs-store.ts`, `deleteIfUnoccupied`). The other three were checked at the same commit and do NOT have it — Stop sends its signed `pause` only after the owner-only CAS has won (`setEnvPaused`), and both approval-revoke routes check `drive_env_local.ownerId` before `revokeLocalEnvApproval`. Any new pairing must use the same shape. `llb2x2c5rew97nxg9xkio7u1` (Done) |
| R-13 | **A deny-list of sensitive writes can never be complete, and escalation does not make it complete.** The classifier (`classify-write.ts`) escalates the writes that are *recognisably* commands — VCS metadata, shell startup files, build and task files, package manifests, CI configs, tool configs, and any file that will be executable once the write lands — including one that already is, whose permissions a mode-less write would leave untouched. **A write to ordinary source code that the owner later builds or runs is still execution**, and no list of filenames catches it: an agent that edits `src/index.ts` in a project the owner runs `bun dev` on has achieved code execution without touching a single name on the list. The rule is deliberately generous (a miss costs one click, not a breach) and case-insensitive, because macOS and Windows resolve `MAKEFILE` and `Makefile` to the same file — but generosity is not completeness. This raises the cost of the obvious vectors and puts a human in front of them; **it is not a boundary.** Only OS confinement (R-3) is. | Certain by construction | High where it applies — but it strictly *reduces* what Tier A used to allow silently | Post-GA, with R-3 | `bos8qmmwx4kkbx7v7huw3hhi` |

## Flag-on checklist

Each item is a command whose output is the evidence, or a task that must read Done. Run from
the repository root on the commit being deployed.

1. Wave 3 is present on the deployed commit — all four checks print a match:
   `psql "$DATABASE_URL" -c "\d drive_env_grant_audit" | head -1`;
   `grep -c "audit_unavailable" apps/web/src/lib/env-bridge/bridge-client.ts` (fail-closed sign);
   `grep -c "pausedAt" packages/lib/src/env-bridge/decide-sign.ts apps/web/src/lib/env-bridge/pause.ts`;
   `grep -c "daemonEpoch" packages/lib/src/env-bridge/frame-codec.ts`.
2. Exit gate recorded: tasks `banj4poxtulz6g68ai42y666` and `kwf7rgkes4q9olq3ytpou16w` are Done
   with the report on `ukqmwy41zkf192hwgh6sqsxf`. **Satisfied 2026-09-09**: both Done; the report
   carries all 40 `GATE` lines, 40 PASS / 0 SKIP, from a production build of this branch.
2a. The sensitive-write escalation is present on the deployed commit — all three print a match:
   `test -f packages/lib/src/env-bridge/classify-write.ts && echo ok`;
   `grep -c "sensitive_write" packages/lib/src/env-bridge/decide-execution.ts`;
   `grep -c "file:" packages/lib/src/env-bridge/decide-approval.ts`;
   `grep -c "createStatMode" packages/cli/src/env-bridge/path-probe.ts packages/cli/src/commands/env/connect.ts`.
   And the behaviour, on the rig, with the flag on: an injected page asking for a
   `.git/hooks/pre-commit` write must produce a Tier B card naming that file and its reason, and
   the file must **not exist** afterwards until the owner clicks — while an ordinary write inside
   the same root still lands with no card (gate rows `P23a`/`P23b`).
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
   prints `404`. **Satisfied locally 2026-09-09** — gate rows `N11a/b/c`, all three bridge entry
   points `404` with the flag unset, and `N10`: a well-formed `POST /envs {substrate:'local'}`
   answers `501`, while a Sprite env still creates (`201`), so the flag gates local envs and not
   the feature. Re-run against the deployment host before the flag goes on there.
9. The customer page is live and says nothing this document does not:
   `curl -s -o /dev/null -w '%{http_code}\n' https://pagespace.ai/docs/security/local-environments`
   prints `200`. **Not satisfiable before deploy** — the marketing app has to ship this page first;
   the gate cannot answer it from a local run.
10. Set `LOCAL_ENVS_ENABLED=true`; then repeat item 8 and expect `400` (the route now exists and
    rejects an empty body), and enrol one machine end to end per the README. **Satisfied locally
    2026-09-09** — gate row `F02` is that `400` from the same route, and steps 1–5 of the runbook
    are one machine enrolled end to end: key pinned, signed `hello` accepted, capabilities
    persisted, a session bound carrying `envId` with the Sprite columns NULL, a file written and
    read back on the machine's own filesystem, a command run through the owner's click (`exit 0`),
    and a >30 s command that completed in 35 s rather than being aborted. Repeat on the
    deployment host.

## Out of scope

- **PTY sessions (M2).** `pty_open` is advertised unsupported by the daemon
  (`dispatcher.ts`, `DAEMON_CAPABILITIES`); the PTY frame model needs [D-2].
- **Consumers (M3).** PanePicker and the `pagespace pane` viewer.
- **Global assistant ([D-4]).** A driveless session cannot bind any environment; changing that
  is its own task with its own tests.
- **Windows.** `env connect` refuses to start there (`packages/cli/src/commands/env/connect.ts`).
