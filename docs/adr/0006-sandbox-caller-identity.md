# ADR 0006 — Sandbox Caller Identity: channel binding, not a bearer

- **Status:** Proposed (L1·G1a contract — freezes how a credentialed operation involving a sandbox is identified; G4 implements the relay)
- **Date:** 2026-09-15
- **Deciders:** Agent Accounts & Credential Broker epic (`j471yhv7p3abea7mlxrchdu1`), D-18 (answered: server relay first; S1 confirms relay-only), Control Board §1 row "Sandbox caller identity"
- **Related:** spike S1 (`docs/spikes/2026-09-sprites-trusted-transport-spike.md`, every claim below marked *verified* was observed on the wire there); ADR 0004 §2 (the `sandbox` and `presenter` fields); threat model §3, A4, A5, Λ1, Λ6. House style: ADR 0003.
- **Frozen surface:** the `sandbox` and `presenter` fields of the grant, the `SandboxBinding` type in `grant.ts`, and the rule that **no presenter key, bearer or credential is ever placed in a guest**.

## Question

When a credentialed operation must touch a sandbox (a `git push` from a workspace, a `gh` call, a CLI relay), what identifies the sandbox to the authority, and who presents the grant?

## Decision (summary)

**The sandbox never presents anything.** Every credentialed operation that involves a sandbox is originated by the **server-side relay runner** (`aud: 'relay-runner'`), which holds the grant, resolves the credential inside the plane, performs the upstream action, and reaches into the guest only over the **server→guest channel the provisioner already owns** (exec / session / proxy under the org Sprites token). The grant binds the sandbox by `(spriteName, spriteInstanceId, generation)` — observable server-side, ABA-safe, not secret — and the presenter is the runner's own key. A guest→server "ask the broker for a credential" channel is **not built**; an egress gate that substitutes credentials is a later, separately decided design (D-18's end state) and, if built, sits outside the guest's administrative control.

---

## 1. Verified ground truth (S1, on `@fly/sprites` runtime `0.0.1-rc48`)

1. **No request attribute reaching our origin authenticates the guest.** Every header the guest sends is guest-authored — `Authorization`, the head of `X-Forwarded-For`, `X-Forwarded-Proto/Port/Ssl`, any `X-Sprite-*` (*verified*, S1 §2). `Sprite-Client-Ip` is set by the sprite inbound edge and exists only for servers *behind* `<name>.sprites.app`, which our origin is not. The source IP is a shared NAT pool (*verified*, S1 §2.1). Codex's premise ("edge hostname, source IP, claimed Sprite ID do not authenticate a guest") holds.
2. **The guest is root and the local socket is world-readable** (`uid=0`, `/.sprite/api.sock` mode `srw-rw-rw-`, *verified*, S1 §3.1–3.2). A secret at rest in the guest is extractable — file modes, a protected daemon, a hidden env var all fail against root.
3. **The guest cannot authenticate itself to anything outside the VM**: no metadata endpoint, the gateway refuses every port, `api.sprites.dev` answers 401 to no/forged tokens (*verified*, S1 §3.3). SPIFFE-style identity machinery inside the guest would establish no boundary.
4. **The provisioner already holds a channel the guest cannot forge**: exec / `createSession` / `proxyPort` are server-initiated, org-token-authenticated, addressed by sprite name; a raw WebSocket to `/v1/sprites/{name}/proxy` opened with the org token and was rejected with a forged token and with none (*verified*, S1 §3.4). It is server→guest only.
5. **The instance id is observable server-side and ABA-safe but not confidential**: `createSprite`/`getSprite` return `sprite-<uuid>`; it survives checkpoint/restore and changes on delete+recreate under the same name (*verified*, S1 §4); the guest can read its own id from `/info` with no token (*verified*, S1 §3.2).
6. **Today no PageSpace credential enters any guest** (B0 §Λ6: 0 hits for `PAGESPACE_*|MCP_TOKEN` in the sandbox env; the env allowlist is empty, `sandbox-env.ts:97,109,144-146`) — except the GitHub token exported per git exec (Λ1, `git-tool-runners.ts:64-71`), which L4 removes.
7. **Both candidate egress brokers put a guest-held bearer in the sandbox** (Infisical Agent Proxy's `connect` client secret; Agent Vault's session token — S2 §3.3) and rely on `HTTPS_PROXY` + a trusted CA that root can unset. They do not solve identity; they assume it.

## 2. Decision D1 — the relay is the caller; the guest is the execution surface

| Operation today | After L4 (G4) |
|---|---|
| `git_push` etc.: server exports `GH_TOKEN` + a credential helper into the guest and runs `git` there (`git-tool-runners.ts:64-71,158-165`) | the runner obtains a grant for `operation: { class, name: 'git-receive-pack' }` bound to `(repo, branch, refspec)` as `resources`; **resolves the token inside the plane**; performs the smart-HTTP push **from the runner** against a bundle/objects it reads out of the guest over the exec/session channel (or drives a constrained smart-HTTP relay the guest's `git` talks to *without* credentials, bound to repo+operation, LFS endpoints included); the guest never holds the token |
| `gh <anything>` with `GH_TOKEN` in env | only typed `gh_*` operations the relay supports; arbitrary `gh` is not made safe by one env var and is not offered with credentials |
| CLI relays (`pagespace` inside the guest calling PageSpace) | unchanged: the guest holds a PageSpace credential only if the user put one there; that is outside this epic's plane and stays bounded by the caller ceiling |

The relay runner is an **executor** (`relay-runner.ts`, I/O file) with decisions in pure modules: `restrictGitOperation` (repo/branch/refspec/`--flag` refusal — B0 Highs and B-3/B-18 become table rows), `planRelayTransfer` (what bytes move which way over the channel).

## 3. Decision D2 — the grant's sandbox binding

`SandboxBinding = { readonly spriteName: SpriteName; readonly instanceId: SandboxInstanceId; readonly generation: SandboxGeneration }` — all three required when `sandbox` is non-null.

- `instanceId` comes from `getSprite(name).id` read by the runner **at issuance and again at presentation**; a restored-from-snapshot sprite keeps its id (legitimate resume), a reclaimed-and-recreated one does not (`generation_mismatch`, ADR 0004 F9).
- `generation` is the provisioner's monotonic counter on `agent_workspaces` / `machine_sprite_reclaims`, incremented on every recreate **and** on every checkpoint restore, so a grant issued before a restore fails after it even though the instance id survived. The two together are the ABA guard: the id catches recreation, the generation catches restore.
- The guest's own view of its id (`/info`) plays no role; the binding's security rests on the org-token channel and the digest, never on the id being secret (S1 §5 point 5).
- `presenter = { keyId: <runner key>, channel: 'relay-runner' }`; `aud = 'relay-runner'`. A grant with `aud: 'relay-runner'` and `sandbox: null` is `malformed` (a relay op without a sandbox is meaningless); a grant with `sandbox` set and any other `aud` is `malformed` too.

## 4. Decision D3 — what is never built in G4

1. **No bearer, presenter key, or credential inside the guest** — not in env, argv, files, `/.sprite`, git config, `gh` hosts.yml, or checkpoints. The hostile-guest extraction sweep (G4 exit) asserts absence across env, argv, `/proc/*/environ`, files, helpers, checkpoints — replacing `env | grep -i token` (Codex).
2. **No guest→broker request path.** There is no endpoint the guest can call to obtain a credential or a grant, because nothing the guest could send authenticates it (§1.1–1.3).
3. **No credential helper that hands Git the token**, even a "broker-only handle" helper: a helper in the guest still violates invariant 1 if `git` runs there with a resolvable handle. A helper may exist only if it returns nothing usable outside the relay's own channel.
4. **No guest-root-controlled proxy.** An egress proxy that substitutes credentials is bypassable if the guest administers it (root unsets `HTTPS_PROXY`, removes the CA). If the Sentinel-style gate is ever built (D-18 end state, L7+), it terminates *outside* the guest, authorizes the concrete request by digest, and recognizes surrogates only in designated auth locations.

## 5. Decision D4 — what would change this ADR

Only a Sprites primitive that (a) lets the **server** inject a per-connection secret bound to the instance and unreadable across a reclaim, **and** (b) gives guest code an authenticated channel back to the broker keyed on that binding. Neither exists on `0.0.1-rc48` (S1 §5). Re-running S1 §3.2–3.4 against a newer runtime is the entry criterion for revisiting; until then this ADR's D3 list is frozen.

## 6. Fail-closed posture (every line is a RED test)

| # | Situation | Behaviour |
|---|---|---|
| F1 | Grant `aud: 'relay-runner'` with `sandbox: null`, or `sandbox` set with another `aud` | `malformed` |
| F2 | `getSprite(name).id ≠ grant.sandbox.instanceId` at presentation | `generation_mismatch` |
| F3 | Provisioner generation ≠ `grant.sandbox.generation` (restore or recreate since issuance) | `generation_mismatch` |
| F4 | A request carrying any guest-authored identity claim (`X-Sprite-*`, `Sprite-Client-Ip`, source IP) | ignored entirely; never an input to any decision (a test proves the verifier's input type has no such field) |
| F5 | `getSprite` unreachable at presentation | `binding_unavailable` (a `GrantDenyReason`); never trust the issuance-time id alone |
| F6 | A git operation whose `remote`/`branch`/refspec starts with `-`, contains a NUL, or names a repo/branch outside `resources` | `restrictGitOperation` refuses before any grant is requested |
| F7 | Runner asked to place a credential into the guest by any path | not representable: the runner's guest-side API is `{ exec(argv, env ⊆ allowlist), readObjects, writeObjects }` with the env allowlist frozen empty for credentialed ops |
| F8 | The exec/session channel drops mid-operation | the upstream action is already done or not; the runner reports `outcome: 'unknown'` (threat-model §2.4), never retries a non-idempotent push |

## 7. Pure-function signatures (G4 implements behind `relay-runner.ts`)

```ts
// packages/lib/src/agent-accounts/relay/restrict-git-operation.ts (G4)
export type RestrictGitOperation = (input: { request: GitRelayRequest; restrictions: ResourceRestrictions }) =>
  { ok: true; canonical: CanonicalRequest } | { ok: false; reason: 'flag_injection' | 'repo_not_allowed' | 'branch_not_allowed' | 'operation_not_supported' | 'malformed' };
// G1c R11: ResourceRestrictions is defined in canonical-request.ts (restriction key → allowed values).
// restrictGitOperation is no longer a second constructor of CanonicalRequest.resources: relay operations
// have OperationRegistryEntry rows (channel 'relay-runner') whose derivedResources rules
// ('receive_pack_ref_names' | 'receive_pack_branches') are parsed from the git-receive-pack pkt-line
// command list by the pure deriveGitResources, inside canonicalizeRequest — so the digest the grant
// binds is recomputed from exactly the refs pushed, and a ref starting with '-' or carrying NUL is
// flag_injection before any grant is requested.

// packages/lib/src/agent-accounts/relay/decide-sandbox-binding.ts (G1b — it is part of verifyGrant's expected-binding fact)
export type DecideSandboxBinding = (input: { grant: SandboxBinding | null; observed: SandboxBinding | null;   // all three fields compared (ADR 0004 F9)
  aud: PresenterChannel }) => { ok: true } | { ok: false; reason: 'malformed' | 'generation_mismatch' | 'binding_unavailable' };

// packages/lib/src/agent-accounts/relay/plan-relay-transfer.ts (G4)
export type PlanRelayTransfer = (input: { operation: GitRelayOperation; guestState: GuestRepoFacts }) =>
  { steps: readonly RelayStep[] };   // read pack from guest → push from runner → write refs update into guest; no step carries a credential toward the guest
```

## 8. Testable assertions (each becomes a RED test in G1b (1–4) or G4 (5–9))

1. Given `decideSandboxBinding` with `aud: 'relay-runner'` and `grant: null`, returns `malformed`; with `sandbox` set and `aud: 'http-executor'`, `malformed`.
2. Given an observed `instanceId` that differs from the grant's, `generation_mismatch`; given the same id but `generation + 1`, `generation_mismatch` (the restore case); given the same id and generation but a different `spriteName`, `generation_mismatch` (all three fields are compared; `ExpectedBinding.sandbox` is a full `SandboxBinding`).
3. Given `observed: null` (store/API unreachable), `binding_unavailable` — never `ok`.
4. Given the verifier's input type, no field can carry a guest-supplied header or IP (a type-level test: `VerifyGrantInput` has no key matching `/header|ip|forwarded|sprite/i` except `sandbox`).
5. Given `restrictGitOperation` with `branch: '--force'`, `remote: '--mirror'`, `branch: '--upload-pack=x'`, `base: '--output=/x'`, each returns `flag_injection` (the B0 High and B-3/B-18 rows as a table).
6. Given a repo outside `restrictions.repos`, `repo_not_allowed`; a branch outside `restrictions.branches`, `branch_not_allowed`.
7. Given a real sprite and a real push through the runner (integration, synthetic token against a throwaway repo): the guest's env, argv, `/proc/*/environ`, `~/.gitconfig`, `~/.gh-config/hosts.yml`, `/.sprite`, and a checkpoint taken mid-operation contain no token bytes (the extraction sweep; the token is a canary string).
8. Given a grant issued, then the sprite deleted and recreated under the same name, presenting the grant returns `generation_mismatch` (the S1 §4 case, end-to-end).
9. Mutation pairs: break the `instanceId` compare and the `generation` compare by line index → assertions 2 and 8 red; restore → green.

## 9. Consequences

- L4's exit ("hostile-guest extraction sweep finds nothing; push + API call via the relay; restored-generation replay denied; `git-tool-runners.ts` injection removed") follows directly from D1–D3; Λ1 is retired and Λ6 bounded there.
- Until L4, Λ1 stands as accepted under D-23, with B0's two widenings (another user's local daemon; shared drive-env collaborators) recorded in the threat model and D-25 as the interim bound.
- The env-bridge (local machines) is unchanged by this ADR: its daemon is a *user-owned* trust boundary with its own enrolled key; Codex's note that a compromised local host can be asked to sign applies and is recorded in the threat model, not solved here.

---

## Amendment 2026-09-15 — the server-opened duplex channel is a caller-identity primitive; L4 design deferred to G4

**Why this amendment exists.** §1.4 and D3.2 above were written on S1's first-draft claim that "there is no reciprocal channel on which guest-resident code authenticates itself to the broker" and that the provisioner's channel "is server→guest only". The PR #2633 review (thread on S1 §3.4) showed that claim to be overstated, and S1 §3.4/§5 were corrected in `eb24f4e46`. This section records the correction here so the ADR does not freeze a design on a false premise. Nothing in D1–D3 is *withdrawn*; D3.2 is *narrowed*, and a second design is recorded as an alternative for G4 to decide between.

### A1. Corrected ground truth (replaces the last clause of §1.4)

- **True, verified (S1 §3.3):** the guest cannot **originate** an authenticated connection to anything outside the VM. No metadata endpoint, the gateway refuses every port, `api.sprites.dev` answers 401 to no/forged tokens, and the `/v1/sprites/{name}/proxy` handshake is rejected with a forged or absent token.
- **True, verified (S1 §3.4):** exec / `createSession` / `proxyPort` are opened by the **server**, authenticated by the org token the server holds, and addressed by sprite name; the server independently verifies `(name, instance id)` via `getSprite`.
- **Overstated in the first draft:** "the channel is server→guest only". Once open, the channel is **duplex**. The proxy tunnel carries whatever the guest sends to the tunnelled port back to the server; an exec stream carries stdout/stderr back. Those bytes arrive on a connection the server authenticated and bound to that sprite instance. So guest-originated *requests* can carry a server-established identity — the identity being "this sprite instance, generation N", established by the server's binding and never by anything the guest presents.

### A2. Two sound designs for L4, both with the decision and the credential on the server side

| | (a) Relay-only (D1 as written) | (b) Bound reverse-request relay (the alternative recorded here) |
|---|---|---|
| Who originates the credentialed operation | the relay runner | guest code, over a channel the runner opened |
| Caller identity | the runner's own key; the sandbox is bound by `SandboxBinding` | the channel binding: `(spriteName, instanceId, generation)` verified by the runner at open **and** re-checked at presentation |
| What the guest can send | nothing that is an input to any decision (F4) | request bytes that are **hostile input with a trustworthy source** — authorized per request by digest, origin pin and approval exactly as (a) |
| Credential placement | resolved in the plane, used by the runner | resolved in the plane, substituted host-side *after* authorization; never enters the guest |
| Moving parts | fewest; no parsing of hostile bytes per request | a request parser and a per-request authorization path on the runner side; channel lifecycle tied to generation |
| Frozen-shape impact | none | none — `SandboxBinding`, `presenter` and `aud` are unchanged; the presenter is still the runner's key, `aud` is still `'relay-runner'`, and the binding is still the three-tuple |

**Caveats that apply to (b), each a RED test if it is built:**
1. The channel identifies the **sprite**, not a benign process inside it. Root authors every byte, so a request over the channel gets exactly the trust a request from a hostile principal gets: narrowly scoped, digest-authorized, approved on write. The channel supplies *source*, never *legitimacy*.
2. **Replay/generation binding is still required.** A channel must be closed on any generation bump (restore *or* recreate, ADR 0004 F9 / this ADR F2–F3), and the binding is re-checked at presentation, not only at open; `getSprite` unreachable ⇒ refuse (F5).
3. **Identity never comes from request contents** (F4 stands): no header, bearer, or guest-read `/info` id is an input to any decision. The verifier's input type still carries only `sandbox`.
4. Nothing about (b) lets a private key or bearer inside the guest substitute for host-side substitution (D3.1, D3.3, D3.4 stand unchanged).

### A3. What changes in the text above

- **§1.4**, last sentence "It is server→guest only." → read as "It is server-**opened**; once open it is duplex (A1)."
- **D3.2** "No guest→broker request path … because nothing the guest could send authenticates it" → narrowed to: **no guest-*originated* request path**, and no path in which the guest's *contents* authenticate it. A request path that rides a server-opened bound channel is design (b), not excluded by D3, and is decided at G4.
- **D4** (what would change this ADR) stands for the *guest-originated* case: the duplex channel is not (b) of D4, because the guest cannot open it and its identity is the server's binding, not a guest-held secret — which is exactly why it is usable.
- **S1 §5** (as amended): relay-only is the recommended v1; (b) is the primitive if L4 needs guest-originated requests.

### A4. Decision status

**Deferred to G4.** G4's brief chooses (a) or (b) — or (a) for git/CLI with (b) reserved for L7+ — against the caveats in A2. Whichever it picks, the L4 exit is unchanged: hostile-guest extraction sweep finds nothing; restored/recreated-generation replay denied; `git-tool-runners.ts` injection removed. If G4 chooses (b), assertions 1–9 in §8 still hold and it adds: (10) a request arriving over a channel whose generation has since bumped is refused before parsing; (11) a request whose bytes carry any identity claim is authorized identically to one without (the claim is not an input); (12) the same canonical request sent over two channels bound to different sprites yields two different digests bound to two different `sandbox` facts.
