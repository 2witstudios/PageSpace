# M1 exit gate — Local Environments zero-trust bridge

The runbook and harness for **t10**, the exit gate of milestone M1 of the
*Local Environments — zero-trust bridge* epic (`j945few5ssv75k5ad0bowbb4`,
task `ukqmwy41zkf192hwgh6sqsxf`).

**Status: this gate has NOT been run.** Everything here is written to be run;
nothing in it has executed against real hardware. M1's code is merged
(#2527 #2528 #2529 #2531 #2532 #2534 #2537 #2543 #2546 #2551) and every layer
is unit-tested and mutation-checked, but no part of the chain has ever run end
to end with the real CLI against a real app. Until the gate below is run and
its lines recorded on the task page, M1 is code-complete and unverified.

This gate also carries **t06's identity negatives**, whose own real-client
check was never run either (it was deferred for a build slot when #2534
merged). They are `N01`–`N11` below.

## What this gate proves, and what it does not

Per the founder's **[D-1]** ruling (epic page, resolved 2026-09-07), local
execution is gated by the machine owner's `ask`/`allowlist`/`deny` policy plus
the server policy, and is **not path-confined**. The negatives here therefore
test **policy enforcement, replay refusal and revocation**. They do not, and
cannot, test filesystem confinement of a running process: an approved command
runs with the machine owner's own privileges. `P05` (the path-escape row)
stays, and its meaning is exactly this: an agent cannot *name* a path outside a
root. It proves nothing about what a program does after it starts.

## Evidence format

Every check prints one line:

```
GATE <id> <PASS|FAIL|SKIP> expected=<value> actual=<value> :: <note>
```

`expected` is the exact denial reason, status code or close code — never a
category. A SKIP is an unfinished gate and makes the exit code non-zero; a
skip has to be explained on the task page before the gate can be called
passed. Copy the `GATE` lines onto the task page verbatim.

## Environment (preconditions)

`preflight.ts` refuses loudly when any of these is missing. Several have cost
this repo a run before.

| id | condition | why |
|----|-----------|-----|
| F01 | the web app answers | everything else is downstream of it |
| F02 | `LOCAL_ENVS_ENABLED=true` in `apps/web/.env.local` | invariant 11; without it the bridge routes do not exist |
| F03 | `ENV_BRIDGE_SIGNING_KEY` set | grants cannot be signed; the app refuses to boot with the flag on and no key |
| F04 | the CLI under test is the **built** `packages/cli/dist/bin.js` | #2546 found `env enroll` broken in the real binary while its unit tests passed |
| F05 | a TTY on stdin | `ask` mode refuses to start without one |
| F06 | `TZ=UTC` on the app process **and** on Postgres | otherwise sessions revoke instantly |
| F07 | `DEPLOYMENT_MODE=onprem` | keeps external integrations out of the run |
| F08 | an S3 endpoint configured | page/drive creation 500s on `CredentialsProviderError` without one |
| F09 | `pagespace env policy` reports a policy in force | no policy = deny-all, and every negative would "pass" for the wrong reason |

Generate a signing key with:

```bash
node -e "const k=require('crypto').generateKeyPairSync('ed25519');console.log(k.privateKey.export({type:'pkcs8',format:'der'}).toString('base64'))"
```

Full app-launch details (prod build, `WEB_APP_URL`, session/CSRF seeding) are
in the operator's `reference_running_web_app_locally` notes.

```bash
export PAGESPACE_GATE_HOST=http://127.0.0.1:3000
export PAGESPACE_GATE_CLI=$PWD/packages/cli/dist/bin.js
export PAGESPACE_GATE_APP_TZ=UTC PAGESPACE_GATE_DEPLOYMENT_MODE=onprem PAGESPACE_GATE_S3_ENDPOINT=http://127.0.0.1:9000
bun scripts/env-bridge-exit-gate/preflight.ts
```

### The policy file

Write `~/.pagespace/env-policy.json`, `chmod 600`, owned by the user running
the daemon. A gate policy that exercises both the pre-approved and the prompted
path:

```json
{
  "mode": "ask",
  "principals": ["<your PageSpace user id>"],
  "ops": ["fs_read"],
  "roots": ["/Users/<you>/pagespace-gate", "/workspace"],
  "envAllowlist": ["CI"],
  "maxBytes": 1048576,
  "maxTimeoutMs": 120000
}
```

`fs_read` is pre-approved so the replay/tamper injections (R1–R3) complete
inside the grant's 60 s window without a human in the loop; `exec` is *not*, so
step 4 exercises the prompt.

> **`/workspace` is in `roots` on purpose, and it is a finding, not a
> workaround.** The agent tool layer confines every `cwd` and every file path to
> the Sprite root `/workspace` *before* the local host sees it
> (`packages/lib/src/services/sandbox/sandbox-paths.ts:20`,
> `tool-runners.ts:972-1012`), and nothing translates that to the machine's own
> roots. Without `/workspace` in `roots` — and an actual `/workspace`
> directory on the machine, or `spawn` fails ENOENT — every agent tool call
> against a local env is denied `cwd_denied`. See drift **D-c** in the dry-run
> audit on the task page.

## Procedure

Run in order. Steps 1–5 are the task page's; the negatives follow.

### 1 · Create the env and enroll the machine

As a drive **owner or admin**:

```
POST /api/drives/<driveId>/envs  { "name": "mac", "substrate": "local", "label": "<machine>" }
  → 201 { env: { substrate: 'local', status: 'disconnected' }, enrollment: { enrollmentId, code, expiresAt } }
```

The code is shown **once**. Then, on the machine — through the capture proxy,
so the same run yields the frames the later negatives need:

```bash
bun scripts/env-bridge-exit-gate/bridge-proxy.ts &     # 127.0.0.1:8788 -> the app
node "$PAGESPACE_GATE_CLI" env enroll <enrollmentId> <code> --host http://127.0.0.1:8788
node "$PAGESPACE_GATE_CLI" env token  <enrollmentId>          --host http://127.0.0.1:8788
```

Use the **same host string** for enroll, token and connect: the CLI keys its
credential store by host.

Evidence to record: the 201 body; `drive_env_local` has `machinePublicKey`,
`enrolledAt`, `enrollmentCodeUsedAt`, `enrollmentCodeHash IS NULL`; `drive_envs`
Sprite columns NULL; after `env token`, `lastSeenAt` is stamped
(`consumeChallenge` writes it) and `GET /envs` reads `connected` for 90 s
(`LOCAL_ENV_HEARTBEAT_WINDOW_MS`).

### 2 · Connect

```bash
node "$PAGESPACE_GATE_CLI" env connect <enrollmentId> --host http://127.0.0.1:8788
```

Expect env status `connected` and the `hello` capabilities persisted
(`shell:true, pty:false, fs:true, checkpoint:false`).

### 3 · Bind a session

From a web pane, as the env **owner**, bind a new session to the local env.
Expect the session row to carry `envId` and **no** Sprite columns (invariant 9).

### 4 · Drive the three operations

Prompt the agent to read a file under an allowed root, write a file, and run a
command that sleeps for more than 30 s. Each should produce a local prompt
(approve it), execute on the machine, and render in the pane.

Three timing facts that decide whether this step can pass at all:

- The bash tool sends `sh -c <command>` with `cwd` under `/workspace`
  (`tool-runners.ts:1010`). See the `roots` note above.
- A grant expires **60 s** after issue (`GRANT_MAX_TTL_MS`), and that window
  covers the prompt: an approval that lands after `exp` is refused
  `approval_expired`. **Answer the prompt promptly.**
- The server's correlator waits `timeoutMs + 5 s`
  (`resolveTimeout`), and the daemon clamps `timeoutMs` to the policy's
  `maxTimeoutMs`. With the defaults above, a >30 s command is not aborted —
  that is the thing being proved.

### 5 · Cross-reference the audit

The server's `auditRequest` rows and the daemon's
`~/.pagespace/env-audit.jsonl` must show the same `grantId`s for the three
operations (invariant 10).

## Negatives

Each must fail safely, and the exact denial is the evidence.

### Identity (`N01`–`N11`) — carried from t06, never run

```bash
PAGESPACE_GATE_ENROLLMENT_ID=… PAGESPACE_GATE_CODE=<the spent code> PAGESPACE_GATE_TOKEN=<mcp_…> \
  bun scripts/env-bridge-exit-gate/identity-negatives.ts
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

**N03** needs an enrollment older than ten minutes: create a second local env,
wait, and pass `PAGESPACE_GATE_EXPIRED_ENROLLMENT_ID` / `_CODE`. **N04** needs
the `(nonce, signature)` pair `env token` already spent; the proxy records it
(`kind:"http"` lines in the transcript) — pass it as
`PAGESPACE_GATE_SPENT_NONCE` / `_SIGNATURE`. Both are SKIPs otherwise, and a
SKIP is not a pass.

**N10/N11 need the app restarted with `LOCAL_ENVS_ENABLED` unset**, so they are
their own pass:

```bash
PAGESPACE_GATE_FLAG=off PAGESPACE_GATE_DRIVE_ID=… PAGESPACE_GATE_COOKIE='…' \
  bun scripts/env-bridge-exit-gate/identity-negatives.ts
```

Enrollment is rate-limited (10/min per IP, 5 per 10 min per enrollment) and the
token endpoints likewise; budget N01–N05 accordingly.

### Frames (`R1`–`R3`) — replay and tamper

Automatic, from the proxy, the moment the daemon answers the first
`grant_exec`. Both constraints below turn a mistake into a *different denial*
rather than a false pass, so read the reason, not just the FAIL:

- Inject into the **same daemon process** that received the frame. After a
  restart, `grantPredatesDaemon` (Codex C6) answers `predates_daemon`.
- Inject inside the grant's 60 s window, or the answer is `expired`. The proxy
  prints the capture age.

| id | injection | expected |
|----|-----------|----------|
| R1 | the captured `grant_exec`, byte-for-byte | `replayed` |
| R2 | the same frame with `grant.argsHash` altered | `args_mismatch` |
| R3 | the same frame with `grant.grantId` altered | `bad_signature` |

R2's expected value differs from the task page, which says `bad_signature`.
That is drift in the page, not a defect: since #2527 the daemon binds the grant
to the frame carrying it and refuses `args_mismatch` **before** verifying the
signature. R3 exists so the signature check is still covered.

### Policy, binding and revocation (`P01`–`P08`) — manual

These need an agent pane and a second drive member, so they are driven by hand
and their `GATE` lines written by the operator.

| id | negative | expected | pinned by |
|----|----------|----------|-----------|
| P01 | no policy file (move it aside, reconnect) | `no_policy` | `policy.ts` → `decideExecution` |
| P02 | policy `chmod 666` | `no_policy` (`writable_by_others` in the log) | `loadMachinePolicy` |
| P03 | a principal not in `principals` drives the env | `principal_not_allowed` | `decideExecution` |
| P04 | decline the prompt | `declined`, audited, nothing runs | `dispatcher.ts` |
| P05 | ask the agent to read `../../etc/passwd` | `path_denied` | `confinePath` via `decideExecution` |
| P06 | a grant carrying `LD_PRELOAD` (`sh -c env` and read the output) | no `LD_PRELOAD` in the child | `scrubEnv` + `exec-runner.ts` |
| P07 | a non-owner member binds to a **connected** env | `bind_policy` | `decideBind` |
| P08 | binding while the daemon is stopped | `not_connected`, Sprite host never called | `local-env-gate.ts` |

**P05's expected reason differs from the task page** (`traversal`/`outside_root`):
those are `confinePath`'s internal classifications, and `decideExecution`
collapses them to `path_denied`, which is what reaches the wire and the audit
log. And to say it once more: P05 proves an agent cannot *name* a path outside a
root. It does not prove a running command is confined — per [D-1] it is not.

**P07 must be run while the env is connected.** `decideBind`'s order is
`flag_disabled → code_exec_denied → not_local → revoked → not_connected →
bind_policy`; against a disconnected env the same attempt answers
`not_connected` and proves nothing about the bind policy.

### Revocation (`P09`–`P12`)

The task page attributes all of this to `pagespace env disconnect`. It does not
do it. `env disconnect` is **local only**: it validates the daemon's pid record
and sends `SIGTERM` (`commands/env/disconnect.ts`). The server-side revoke —
`revokedAt`, session revocation, the 1008 close and the signed `revoke` frame
that makes the daemon delete its key — is `DELETE /api/drives/<driveId>/envs/<envId>`
(`route.ts:136` → `revokeEnv` → `local-env-revoke.ts`). Run both:

| id | action | expected |
|----|--------|----------|
| P09 | `pagespace env disconnect <enrollmentId>` | the daemon exits; children killed; **key retained**; server row unchanged |
| P10 | `DELETE /api/drives/<driveId>/envs/<envId>` | `drive_env_local.revokedAt` stamped, sessions revoked, socket closed `1008` |
| P11 | the daemon that was connected during P10 | logs `revoked`, deletes its key, exits non-zero |
| P12 | `pagespace env token <enrollmentId>` after P10 | refused (`revoked`; the row is deleted with the env, so `not_found` is equally correct) |

## Files

| file | what it does |
|------|--------------|
| `report.ts` | the `GATE` line format and the exit-code tally |
| `preflight.ts` | F01–F09, the preconditions |
| `identity-negatives.ts` | N01–N11, over real HTTP and the built CLI |
| `bridge-proxy.ts` | the capture/reinject proxy; R1–R3, and it records the transcript |
| `ws-min.ts` | a dependency-free WebSocket client/server slice (the root workspace does not depend on `ws`, and `knip:check` is blocking) |

## After the run

Record every `GATE` line on the task page, then:

- any FAIL becomes a bug task on this board **before M2 starts** (the task
  page's own exit criterion);
- any SKIP is explained, or the gate is not passed;
- the epic Status line is updated to say the chain has run on real hardware —
  and not before.
