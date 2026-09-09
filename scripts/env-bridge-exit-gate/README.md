# M1 exit gate — Local Environments zero-trust bridge

The runbook and harness for **t10**, the exit gate of milestone M1 of the
*Local Environments — zero-trust bridge* epic (`j945few5ssv75k5ad0bowbb4`,
task `ukqmwy41zkf192hwgh6sqsxf`).

**Status: RUN on 2026-09-09**, against a production standalone build of
`pu/local-env-ga`, a real UTC Postgres, the built CLI from this tree
(`packages/cli/dist/bin.js`) driving a real enrolled machine, and a real
browser for every click. The evidence is on the task page. One check FAILED
and is filed as `llb2x2c5rew97nxg9xkio7u1`.

Before that run the gate had been written but never executed, and it had been
**re-scoped** against the code GA waves 1–3 merged: several rows asserted
refusals that did not exist when they were written, and several could not fire
at all in the shape the page described. The re-scope is the table at the end;
read it before changing any row back.

## What this gate proves, and what it does not

Per the founder's **[D-1]** ruling (epic page, resolved 2026-09-07, amended the
same day), local execution is gated by the machine owner's `ask`/`allowlist`/
`deny` policy plus the server policy, and is **not path-confined**. The
negatives here test **policy enforcement, replay refusal, revocation and the
Tier B click**. They do not, and cannot, test filesystem confinement of a
running process: an approved command runs with the machine owner's own
privileges.

`P05` splits in two for exactly this reason — see the re-scope table.

## Evidence format

Every check prints one line:

```
GATE <id> <PASS|FAIL|SKIP> expected=<value> actual=<value> :: <note>
```

`expected` is the exact denial reason, status code or close code — never a
category. A SKIP is an unfinished gate and makes the exit code non-zero; a
skip has to be explained on the task page before the gate can be called
passed. Copy the `GATE` lines onto the task page verbatim.

**Where to read the answer matters.** For the P0x family the typed refusal is
the DAEMON's, and it reaches `~/.pagespace/env-audit.jsonl` as
`deny:<reason>`. It does **not** reach the agent's tool result: the transport
maps only `ask_pending:<id>` and the server's own refusal to typed tool
reasons, and every machine-side denial arrives at the model as the generic
`execution_failed`. Read the daemon's audit line, not the chat.

## Environment (preconditions)

`preflight.ts` refuses loudly when any of these is missing. Several have cost
this repo a run before.

| id | condition | why |
|----|-----------|-----|
| F01 | the web app answers | everything else is downstream of it |
| F02 | `LOCAL_ENVS_ENABLED=true` in the app's env | invariant 11; without it the bridge routes do not exist |
| F03 | `ENV_BRIDGE_SIGNING_KEY` set | grants cannot be signed; the app refuses to boot with the flag on and no key |
| F04 | the CLI under test is the **built** `packages/cli/dist/bin.js` **from this tree** | #2546 found `env enroll` broken in the real binary while its unit tests passed; and since wave 3 the `hello` REQUIRES `daemonEpoch`, so a published or pre-wave CLI cannot connect at all |
| F05 | the operator knows where `ask` will ask | **changed by wave 2** — see below |
| F06 | `TZ=UTC` on the app process **and** on Postgres | otherwise sessions revoke instantly |
| F07 | `DEPLOYMENT_MODE` stated | the 2026-09-09 run used `cloud`, which is the GA target; `onprem` also works and keeps integrations out |
| F08 | an S3 endpoint configured | page/drive creation 500s on `CredentialsProviderError` without one |
| F09 | `pagespace env policy` reports a policy in force **on the machine** | no policy = deny-all, and every negative would "pass" for the wrong reason |

**F05 is no longer "a TTY on stdin".** That precondition described wave-1
behaviour: `env connect` used to refuse to start in `ask` mode without a
terminal. Wave 2's challenge store removed the refusal — with no TTY (or with
`PAGESPACE_ENV_ASK=chat`) the daemon freezes each request under a challenge id
and answers `grant_denied ask_pending:<id>`, and the owner answers in the
PageSpace chat. **The headless daemon is the GA path**, so the gate should be
run that way; a TTY run tests a different prompter.

**F09 must be evaluated on the machine.** If the daemon does not run on the
operator's own computer, `pagespace env policy` on the operator's host reads a
policy that has nothing to do with the run.

```bash
export PAGESPACE_GATE_HOST=http://127.0.0.1:3200        # the app itself
export PAGESPACE_GATE_UPSTREAM=$PAGESPACE_GATE_HOST      # what the capture proxy forwards to
export PAGESPACE_GATE_PROXY_PORT=8788
export PAGESPACE_GATE_CREDENTIAL_HOST=http://localhost:8788   # the host `env enroll` runs against
export PAGESPACE_GATE_CLI=$PWD/packages/cli/dist/bin.js
export PAGESPACE_GATE_APP_TZ=UTC PAGESPACE_GATE_DEPLOYMENT_MODE=cloud PAGESPACE_GATE_S3_ENDPOINT=http://127.0.0.1:9112
node --no-warnings scripts/env-bridge-exit-gate/preflight.ts
```

**Run the harness under `node`, not `bun`.** Bun 1.3.14's `node:http` emits the
`upgrade` event with a socket that reports `writable` but whose writes never
reach the client, so `bridge-proxy.ts` swallows its own `101` and every daemon
that dials it sees a hang-up. R1–R3 cannot run under bun at all. (This is why
the harness's relative imports carry their `.ts` extension and `ws-min.ts` has
no TypeScript parameter properties: node's strip-only type stripping needs
both.)

`PAGESPACE_GATE_UPSTREAM` is required by `bridge-proxy.ts` at startup — without
it the proxy exits 2 before the daemon can dial it. `PAGESPACE_GATE_CREDENTIAL_HOST`
must be the host `env enroll` was run against: the CLI stores credentials **per
host**, so N08/N09 against the wrong host inspect an empty profile and pass for
the wrong reason.

### When the machine is not this computer

The 2026-09-09 run used a Linux container as the machine, because the tool
layer sends every `cwd` as `/workspace` (see the roots note) and macOS has a
sealed read-only root that cannot hold one. That is closer to a real
deployment anyway. Two harness inputs exist for it:

```bash
export PAGESPACE_GATE_CLI_EXEC="docker exec gate-machine node"   # up to and including `node`
export PAGESPACE_GATE_MACHINE_CLI=/opt/pagespace-cli/dist/bin.js # where dist/bin.js lives over there
```

N08/N09 then run where the machine credential actually lives. Without them they
inspect an empty profile on the operator's host and pass because nothing is
there — the same class Codex found at #2555.

### Seeding

`seed-gate.ts` mints what no API can mint for itself and what the one-user
`seed-operator.ts` cannot supply:

```bash
DATABASE_URL=… TZ=UTC bun scripts/env-bridge-exit-gate/seed-gate.ts
```

- the machine **owner** on an env-capable tier (`free` is not in
  `SANDBOX_ELIGIBLE_TIERS` and `DRIVE_ENV_LIMIT_FREE` is 0, so a free user
  never reaches any of this);
- a drive **ADMIN who did not enrol the machine** — without a second human,
  P07 and the owner-only rows cannot tell "refused because not the owner" from
  "refused because not a member";
- an **agent with `sandboxEnabled`**, or no tool call can reach a local env at
  all;
- a page **written by that other person** carrying an instruction to run a
  command — the injection case (`P16`).

Two traps the run hit, both of which make a check pass for the wrong reason:

- **Membership needs `acceptedAt`.** A `drive_members` row with a NULL
  `acceptedAt` is refused `drive_access_denied` at the session-spawn door, long
  before `decideBind`. `seed-gate.ts` stamps it.
- **An agent reads with its own permissions.** A factory-created agent holds no
  page permissions, so it cannot read the injected page and the injection case
  proves nothing. Set `userScopedAccess` on the agent (which is also the
  realistic shape: your agent, your access, someone else's content).

### Environment limit

`DRIVE_ENV_LIMIT_PRO` defaults to 2 and the gate needs four or five
environments. Raise it in the app's env before creating them.

### Create four local envs, not one

The negatives need enrollments in different states, and none can be recycled:

| env | state | used by |
|-----|-------|---------|
| **A** | enrolled and connected, `serverPolicy` = exec + fs_read + fs_write | steps 1–5, R1–R3, N01, N04, N05, N06–N09, the whole P family |
| **B** | created, **never enrolled** | N02 (a wrong code must reach the code comparison), P08 (`not_connected`), the flag-off bind |
| **C** | created **more than ten minutes** before the run | N03 (an expired code) |
| **D/E** | created with `serverPolicy.ops` excluding `exec` / empty | the settings surface; `no_server_ops` |

`enrollLocalDriveEnv` checks `enrolledAt`/`enrollmentCodeUsedAt` *before* it
compares the code, so a wrong code against env A answers `409 used` and never
reaches the branch N02 exists to test. A `mismatch` consumes nothing, so env B
survives N02.

### The policy file

**Let `pagespace env enroll` write it.** Since wave 2 the enroller scaffolds
exactly the split the gate wants — `mode: ask`, `principals: [owner]`,
`ops: serverPolicy.ops ∩ {fs_read, fs_write}` (never `exec`), `roots: [cwd]`,
`envAllowlist: []` — so running `env enroll` from `/workspace` produces the
Tier A / Tier B configuration under test, and hand-writing the file only risks
testing something the product does not ship. `chmod 600`, owned by the daemon's
uid, is the enroller's doing too.

File operations are therefore pre-approved (headless, Tier A) and `exec`
reaches the `ask` verdict by construction (Tier B, the owner's click).

> **`/workspace` is the machine's root because the tool layer gives it no
> choice, and that is a finding, not a workaround.** The agent tool layer
> confines every `cwd` and every path to the Sprite root `/workspace` *before*
> the local host sees it (`sandbox-paths.ts`, `tool-runners.ts`), and nothing
> translates that to the machine's own filesystem. So the machine must have a
> real `/workspace` directory and must list it in `roots`, or every agent tool
> call against a local env is denied `cwd_denied`/`path_denied`. See drift
> **D-c** on the task page.

## Procedure

Run in order. Steps 1–5 are the task page's; the negatives follow.

### 1 · Create the env and enroll the machine

As a drive **owner or admin**:

```
POST /api/drives/<driveId>/envs
  { "name": "…", "substrate": "local", "label": "…",
    "serverPolicy": { "ops": ["exec","fs_read","fs_write"], "checkpoint": false } }
  → 201 { env: { substrate: 'local', status: 'disconnected' }, enrollment: { enrollmentId, code, expiresAt } }
```

`serverPolicy` is **required** since wave 1 — a local env cannot be created
without the owner saying what PageSpace may ask of the machine. The code is
shown once. Then, on the machine, through the capture proxy so the same run
yields the frames the later negatives need:

```bash
node --no-warnings scripts/env-bridge-exit-gate/bridge-proxy.ts &   # 127.0.0.1:8788 -> the app
node "$PAGESPACE_GATE_CLI" env enroll <enrollmentId> <code> --host "$PAGESPACE_GATE_CREDENTIAL_HOST"
```

Evidence: the 201 body; `drive_env_local` has `machinePublicKey`, `enrolledAt`,
`enrollmentCodeUsedAt`, `enrollmentCodeHash IS NULL`; `drive_envs` Sprite
columns NULL.

### 2 · Connect

```bash
node "$PAGESPACE_GATE_CLI" env connect <enrollmentId> --host "$PAGESPACE_GATE_CREDENTIAL_HOST"
```

Expect env status `connected` and the `hello` capabilities persisted
(`shell:true, pty:false, fs:true, checkpoint:false`). Headless is the GA path.

### 3 · Bind a session

As the env **owner**, `POST /api/agent-workspaces { driveId, envId, agentPageId }`.
Expect the session row to carry `envId` and **no** Sprite columns (invariant 9).

### 4 · Drive the three operations

Prompt the agent to read a file under an allowed root, write one, and run a
command that sleeps for more than 30 s. File operations run headless; the
command produces a Tier B card in the chat that the owner must click.

Three timing facts that decide whether this step can pass at all:

- The bash tool sends `sh -c <command>` with `cwd` under `/workspace`. See the
  roots note above.
- A grant expires **60 s** after issue (`GRANT_MAX_TTL_MS`). The Tier B click
  is NOT bounded by it — the daemon freezes the request under a challenge whose
  TTL is the grant's `exp`, and the click re-issues a **fresh** grant — but the
  card must be answered inside the challenge's life.
- The server's correlator waits `timeoutMs + 5 s` and the daemon clamps
  `timeoutMs` to the policy's `maxTimeoutMs`. A >30 s command is not aborted;
  that is the thing being proved.

### 5 · Cross-reference the audit

The server's `drive_env_grant_audit` rows and the daemon's
`~/.pagespace/env-audit.jsonl` must show the same `grantId`s, with the same
`op` and `exitCode` (invariant 10). A daemon line with no server row is a
finding **unless** it is one of the R2/R3 tampered grant ids, which the server
never minted — those are the join working.

## Negatives

### Identity (`N01`–`N11`)

```bash
PAGESPACE_GATE_ENROLLMENT_ID=<env A> PAGESPACE_GATE_CODE=<A's spent code> PAGESPACE_GATE_TOKEN=<ps_mcp_…> \
PAGESPACE_GATE_FRESH_ENROLLMENT_ID=<env B> \
PAGESPACE_GATE_EXPIRED_ENROLLMENT_ID=<env C> PAGESPACE_GATE_EXPIRED_CODE=<C's code> \
PAGESPACE_GATE_SPENT_NONCE=… PAGESPACE_GATE_SPENT_SIGNATURE=… \
  node --no-warnings scripts/env-bridge-exit-gate/identity-negatives.ts
```

| id | negative | expected |
|----|----------|----------|
| N01 | re-present the enrollment code | `409 used` |
| N02 | wrong code | `401 mismatch` |
| N03 | expired code | `410 expired` |
| N04 | replay a spent challenge response | `401 used` |
| N05 | signature from another key | `401 bad_signature` |
| N06 | the `env:bridge` token at `GET /api/auth/me` | `401` |
| N07 | the same token at mcp-ws | close `1008` |
| N08 | `pagespace logout --key=env:<id>` | reports not logged in |
| N09 | `pagespace keys use env:<id>` | refuses |
| N10 | flag off: `POST /envs { substrate:'local' }` | `501` |
| N11 | flag off: `/api/env-bridge/*` | `404` |

**N04's spent pair must be the MOST RECENT one.** `issueLocalEnvChallenge`
replaces the stored challenge, so a pair captured earlier in the run answers
`401 nonce_mismatch` — a refusal, but not the replay defence. Capture it from
the last `kind:"http"` line in the proxy transcript, immediately before running
the pass, and do not let the daemon mint in between. A connected daemon holds
its token for 600 s, so the window is comfortable; a reconnecting one is not.

**N04 runs before N05, and the order is load-bearing.** `verifyChallengeResponse`
compares the nonce *before* it looks at `usedAt`, so if N05 fetched its
challenge first, N04's replay would answer `nonce_mismatch`. N05 also leaves
its nonce pending and unconsumed, which is why no later row asks for another
challenge (it would answer `challenge_pending`, HTTP 429, for 60 s — including
to the daemon, which then retries on backoff).

**N10 is a WRITE and needs a well-formed body.** Without `X-CSRF-Token` and a
matching `Origin` it is answered 403 at the door; without a `serverPolicy` it
is answered 400 by wave 1's mint validation. Neither reaches the flag. Both
were harness defects, found by running it.

**N10/N11 need the app restarted with `LOCAL_ENVS_ENABLED` unset**, so they are
their own pass:

```bash
PAGESPACE_GATE_FLAG=off PAGESPACE_GATE_DRIVE_ID=… PAGESPACE_GATE_COOKIE='session=…' \
  node --no-warnings scripts/env-bridge-exit-gate/identity-negatives.ts
```

Enrollment is rate-limited (10/min per IP, 5 per 10 min per enrollment) and the
token endpoints likewise; budget N01–N05 accordingly.

### Frames (`R1`–`R3`) — replay and tamper

Automatic, from the proxy, the moment the daemon answers the first
`grant_exec`. Under Tier B that answer is `grant_denied ask_pending:<id>`,
which is ideal: the nonce is spent, no human sits inside the 60 s window, and
the injections fire milliseconds later.

| id | injection | expected |
|----|-----------|----------|
| R1 | the captured `grant_exec`, byte-for-byte | `replayed` |
| R2 | the same frame with `grant.argsHash` altered | `args_mismatch` |
| R3 | the same frame with `grant.grantId` altered | `bad_signature` |

Inject into the **same daemon process** (otherwise `predates_daemon`) and
inside the grant's 60 s window (otherwise `expired`). R2's expected value
differs from the task page, which says `bad_signature`: since #2527 the daemon
binds the grant to the frame carrying it and refuses `args_mismatch` **before**
verifying the signature. R3 exists so the signature check is still covered.

### Policy, binding and revocation (`P01`–`P18`)

Driven by hand, or by the drivers in the session scratchpad. The daemon loads
its policy **once, at connect**, so every row that changes the policy file
needs a daemon restart before it means anything.

| id | negative | expected | pinned by |
|----|----------|----------|-----------|
| P01 | no policy file (move it aside, reconnect) | daemon audit `deny:no_policy`; the daemon says so at connect | `policy.ts` → `decideExecution` |
| P02 | policy `chmod 666` | `deny:no_policy` (`writable_by_others` named at connect) | `loadMachinePolicy` |
| P03 | the owner removes themselves from `principals` | `deny:principal_not_allowed` | `decideExecution` |
| P04 | click **Deny** on the card | card reads `Denied`; daemon has `ask:pending` and nothing after it | approvals route + `challenge-store.ts` |
| P05a | ask the agent for `../../etc/passwd` | `path_escape` **at the server**; the request never reaches the machine | `resolveSandboxPath` (`sandbox-paths.ts`) |
| P05b | a machine root NARROWER than `/workspace`, then read a file at the sandbox root | `deny:path_denied` **at the daemon** | `confinePath` via `decideExecution` |
| P06 | the daemon's own process carries `LD_PRELOAD` and a secret | the child sees neither, and only the PATH the runner builds | `scrubEnv` + `exec-runner.ts` |
| P07 | a drive ADMIN binds to a **connected** env | `403 bind_policy` | `decideBind` ([D-6]) |
| P08 | binding while the daemon is stopped | `409 not_connected`, Sprite host never called | `local-env-gate.ts` |
| P09 | `pagespace env disconnect <enrollmentId>` | the daemon exits; **key retained**; server row unchanged | `commands/env/disconnect.ts` |
| P10 | `DELETE /api/drives/<driveId>/envs/<envId>?force=true` | `revokedAt` stamped, sessions revoked, socket closed `1008` | `local-env-revoke.ts` |
| P11 | the daemon that was connected during P10 | logs `Environment revoked`, **deletes its key**, exits | `ws-client.ts` |
| P12 | `env token` / enroll after P10 | refused (`not_found`; the row is deleted with the env) | enroll + token routes |
| P13 | a drive ADMIN `PATCH { serverPolicy }` | `403 not_owner`, naming the owner | `setEnvServerPolicy` CAS |
| P14 | a drive ADMIN `PATCH { paused }` | `403 not_owner` | `setEnvPaused` CAS |
| P15 | a drive ADMIN reads activity / approvals | `403 not_owner` on both | activity + approvals routes |
| P15b | the same two pages **in a browser** | the owner's three policy switches are enabled; the admin's are **disabled** | `settings/environments/page.tsx` |
| P16 | **the injection case** — see below | a Tier B card, and nothing runs without the click | the whole Tier B chain |
| P17 | **Stop kills a running command** | `{ machine: 'acknowledged', killed: n }`, the pid gone, exit 137 | `pause.ts` + `dispatcher.ts` |
| P18 | **offline revoke replays** | `409 no_live_socket`, `revokePending: true`, then gone on reconnect | approval mirror + hello replay |
| P19 | `exec` off in `serverPolicy` | `refused:server_denied` with a **NULL grantId**; the daemon never sees a frame | `decideSign` |
| P20 | **[D-7]** hand-edit `exec` into the machine `ops` under `allowlist` | `env connect` and `env policy` print the warning; connect audits `policy_warning:exec_allowlisted`; the command then runs unprompted | `policy-warnings.ts` |

**P05's two halves are the whole point.** The page's single row could not
distinguish "the server would not name that path" from "the machine would not
serve it", and only the second is the invariant. With `roots = ["/workspace"]`
the daemon's arm is unreachable through an agent, because everything the tool
layer can name is already inside `/workspace` — so P05b narrows the machine's
root on purpose.

**P07 must be run while the env is connected**, and **without an
`agentPageId`.** `decideBind`'s order is `flag_disabled → code_exec_denied →
not_local → revoked → not_connected → bind_policy → no_server_ops`, so against a
disconnected env the same attempt answers `not_connected`; and a spawn that
names an agent is refused by that agent's page permissions
(`Insufficient permissions to use this agent`) before the env gate is reached.
Both were observed, and both would have been recorded as P07 passing.

**P16, the injection case, has two arms and needs both.** A shared page written
by someone else carries an instruction to run a command; the owner's agent,
bound to a local env, reads it.

- **P16a — the model declines.** Recorded honestly, and it is what happened on
  2026-09-09. It proves nothing about the mechanism: a different model, or a
  subtler payload, may comply.
- **P16b — the model complies.** The owner asks the agent to carry out the
  page's instruction, so the model has no reason to refuse. The machine must
  still freeze the request under a challenge, the card must show the exact
  normalised command, and the daemon's JSONL must show `ask_pending` and
  nothing else. **This is the arm that proves the Tier B verdict**, because it
  holds whatever the model decides.

## Files

| file | what it does |
|------|--------------|
| `report.ts` | the `GATE` line format and the exit-code tally |
| `preflight.ts` | F01–F09, the preconditions |
| `seed-operator.ts` | one user, one drive, one session — the identity rows |
| `seed-gate.ts` | the second human, the agent, the injected page, the tier |
| `identity-negatives.ts` | N01–N11, over real HTTP and the built CLI |
| `bridge-proxy.ts` | the capture/reinject proxy; R1–R3, and the transcript |
| `ws-min.ts` | a dependency-free WebSocket slice (the root workspace has no `ws`, and `knip:check` is blocking) |

## Re-scope, 2026-09-09 — every row against the merged code

Written before the run, checked by it. "Could it fire?" is about the code at
`ea7357bb0`, not about the page that first described the row.

| row | code path | could its refusal fire as written? | change |
|-----|-----------|-----------------------------------|--------|
| F05 | `commands/env/connect.ts` | **No.** Wave 2 removed the no-TTY refusal | precondition becomes "know where `ask` asks"; headless is the GA path |
| F09 | `commands/env/policy.ts` | Only where the daemon runs | must be evaluated on the machine |
| N01–N07 | enroll/token routes, `challenge.ts` | Yes | unchanged; N04's pair must be the most recent |
| N08–N09 | credential resolver | **Not off-host.** Inspected an empty profile | `PAGESPACE_GATE_CLI_EXEC` runs them on the machine |
| N10 | `envs/route.ts` | **No.** 403 (no CSRF), then 400 (wave 1 requires `serverPolicy`) | send a request a real client would send |
| N11 | enroll/token/ws routes | Yes | unchanged |
| R1–R3 | `grant.ts` `verifyGrant` | Yes, but the proxy could not run | proxy fixed (node, not bun; buffer the `hello`) |
| P01, P02 | `policy.ts` | Yes | read the daemon's audit line, not the tool result |
| P03 | `decideExecution` | Only via the owner's own edit — [D-6] leaves no second principal who can bind | row restated as the owner removing themselves |
| P04 | approvals route | Yes — but it is now a **card click**, not a terminal answer | driven in a browser |
| P05 | `confinePath` | **Half.** The tool layer refuses traversal first | split into P05a (server) and P05b (daemon, narrowed root) |
| P06 | `scrubEnv` | Not through an agent — the tool layer sends no env | inverted: put the variable in the DAEMON's environment and prove the child never sees it |
| P07 | `decideBind` | **Not as written.** Agent permissions answer first; membership needs `acceptedAt` | drop `agentPageId`; seed accepted membership |
| P08 | `local-env-gate.ts` | Yes | unchanged |
| P09 | `commands/env/disconnect.ts` | Yes | unchanged (`env disconnect` is local only) |
| P10–P12 | `local-env-revoke.ts` | Yes | DELETE needs `?force=true` while sessions live — **and see the FAIL** |
| P13–P15b | wave 3 owner-only routes + settings page | **New.** These refusals did not exist before wave 1/3 | added |
| P16 | the Tier B chain | **New.** Tier B did not exist before wave 2 | added, with both arms |
| P17 | `pause.ts`, `dispatcher.ts` | **New.** Stop did not exist before wave 3 | added |
| P18 | approval mirror + hello replay | **New.** The mirror did not exist before wave 3 | added |
| P19 | `decideSign` | **New.** `serverPolicy` was unconsulted before wave 1 | added |
| P20 | `policy-warnings.ts` | **New.** [D-7] was ruled on 2026-09-09 | added |

## After the run

Record every `GATE` line on the task page, then:

- any FAIL becomes a bug task on this board **before the flag is turned on
  anywhere**, naming the layer row in `docs/security/local-environment-bridge.md`
  it contradicts;
- any SKIP is explained, or the gate is not passed;
- the epic Status line is updated to say the chain has run on real hardware —
  and not before.
