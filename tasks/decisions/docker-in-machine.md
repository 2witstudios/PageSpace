# T2.0 — Docker-in-Machine Probe (decision spec)

Gates Epic 2's Branches tier ("Branch = a docker container with that branch checked out").
Runs first, parallel to Epic 1. See `tasks/terminal.md` for the Terminal/Machine model this
decision resizes.

**Method note on evidence labels:** every finding below is labeled **TESTED** (empirically
verified against a real, live Fly Sprite in this session) or **READ** (SDK source / public
docs, not independently re-verified live). Nothing here is speculation without a label.

---

## VERDICT

**Docker-per-branch is NOT viable as-is on a raw Fly Sprite.** Sprites expose no privileged
container runtime, no custom base image, and non-root package installs fail on the privileged
step of `dpkg` unpacking. A **rootless** container runtime (Podman, not Docker) is plausible —
the kernel primitives it needs (user namespaces, overlayfs-in-userns, cgroup v2) are present and
TESTED working — but it requires a bespoke rootless-bootstrap (not a stock `apt-get install
docker.io && docker run`), is unproven end-to-end (install completed only partway before this
probe's time/cost budget stopped), and needs new egress-allowlist and containment-verification
work before it could be trusted.

**Implication:** the Machine-substrate abstraction (Sprite now, Modal/docker-host later) becomes
a **HARD prerequisite** for the Branches tier, not a nice-to-have. Sprites can plausibly stay the
substrate for Epic 1 (agent ⇄ terminal exec, no nested containers), but Branches (docker-per-branch)
should target Modal — which ships purpose-built Docker-in-Sandbox support — from day one, reached
through the same substrate seam. Do not build Branches against raw Sprites and hope to swap later;
build the seam first.

---

## 1. Feasibility

### 1.1 What a Sprite actually is (TESTED + READ)

- **TESTED** (live probe, 2026-07-06, three throwaway Sprites created via the raw `@fly/sprites`
  SDK rc37 and destroyed immediately after): kernel `6.12.91-fly`, Ubuntu 25.10 userland, default
  shell user is **non-root** (`uid=1001(sprite)`), root filesystem is itself an overlay
  (`lowerdir=/mnt/languages-image:/system:/mnt/system-base,upperdir=/mnt/user-data/root-upper/upper`).
- **READ** ([Fly community, "Docker/Podman support?"](https://community.fly.io/t/docker-podman-support/27168)):
  "Sprites do not support Docker images — you start from a base Linux environment and install
  dependencies manually" and "user code runs in a nested container within the Sprite." This is
  consistent with what was tested: the sprite user is not root and does not have unrestricted
  mount privileges over the real root namespace (see 1.3) — the shell we get is itself already
  inside a container-like confinement Fly's own init sets up, before any of our own nesting.

### 1.2 SDK/config surface (TESTED via source inspection)

Read the actual cached SDK package (`@fly/sprites@0.0.1-rc37`, the exact version pinned in
`packages/lib/package.json`), not just its README:

- `SpriteConfig` (`dist/types.d.ts`) exposes exactly four fields: `ramMB`, `cpus`, `region`,
  `storageGB`. **No `image`, `privileged`, `capabilities`, or device-passthrough field exists.**
  Every Sprite boots from Fly's fixed base image; there is no supported way to bake a container
  runtime into a custom image today.
- No mention of `docker`, `privileged`, `kvm`, `nested`, `runc`, or `cgroup` anywhere in the SDK's
  `dist/` output — the product surface was not designed with nested-container workloads in mind.
- The SDK does expose `createCheckpoint`/`restoreCheckpoint` (filesystem + process checkpoint).
  PageSpace's own driver (`sandbox-client/sprites.ts`) never uses this — `stop()` always
  `deleteSprite`s ("no orphaned/idle billing"). Checkpointing is a **plausible but UNTESTED** route
  to amortize a one-time runtime install across Sprites, not evaluated further here.

### 1.3 Kernel primitives Docker/Podman need (TESTED, live probe)

| Primitive | Result | Evidence |
|---|---|---|
| cgroup v2 unified hierarchy | ✅ present | `stat -fc %T /sys/fs/cgroup` → `cgrp` magic (`0x63677270`) |
| cgroup controllers delegated | ✅ `cpuset cpu io memory hugetlb pids` | `cat /sys/fs/cgroup/cgroup.controllers` |
| overlayfs kernel module | ✅ present | `overlay` listed in `/proc/filesystems` |
| user namespaces | ✅ enabled, generous limit | `max_user_namespaces` = 63951; no `unprivileged_userns_clone` gate present (not a hardened/patched kernel) |
| `unshare --user --map-root-user (+pid+mount+uts+ipc+net)` | ✅ works | ran `id` inside → `uid=0(root)` (mapped), plus a fresh netns showing only `lo` |
| **overlay mount as plain (non-namespaced) shell user** | ❌ fails | `mount: must be superuser to use mount` (exit 32) — even though... |
| ambient capability set on the non-root shell | non-empty: `CHOWN, DAC_OVERRIDE, FOWNER, FSETID, KILL, SETGID, SETUID, SETPCAP, NET_BIND_SERVICE, NET_ADMIN, NET_RAW, SYS_CHROOT, SYS_ADMIN, MKNOD, AUDIT_WRITE, SETFCAP` | decoded `CapEff` bitmask (`0xa82435fb`) bit-by-bit via a Python one-liner inside the Sprite |
| **overlay mount inside a proper `unshare --user --map-root-user --mount` namespace** | ✅ **works** — mounted, wrote a file into it | this is the standard rootless-container storage mechanism, and it works |
| `/dev/kvm` (nested virtualization / hardware VM-in-VM) | ❌ absent | `ls /dev/kvm` → No such file or directory |
| plain `mount --bind` outside a fresh userns | ❌ fails, same "must be superuser" | confirms the ambient CAP_SYS_ADMIN only counts inside a namespace we ourselves own (mapped root), not over the Sprite's real/initial mount namespace — a genuine, working isolation boundary |

**Reading of the capability result:** Fly deliberately grants the sprite user a curated,
non-empty capability set (including `CAP_SYS_ADMIN`) rather than plain POSIX-root-less confinement
— this is what makes user-namespace-based sandboxing (the rootless-container mechanism) possible
at all from inside a Sprite. But those capabilities are scoped: they do not let the shell touch the
*real* root mount namespace, only namespaces the shell itself creates and maps root into. This
matches exactly how rootless Podman is designed to work, and it worked in the live test.

### 1.4 Actually installing a runtime (TESTED, partial — this is the load-bearing gap)

- Egress on a Sprite created via the raw SDK (bypassing PageSpace's own
  `applyEgressLockdown`) is open by default: DNS resolved `deb.debian.org`/`archive.ubuntu.com`,
  `curl` to `download.docker.com` returned `HTTP_200`, `apt-get update` succeeded.
- `apt-get install -y podman` (run as the plain non-root shell user, **not** inside a mapped-root
  userns) downloaded all packages (podman, crun, fuse-overlayfs, netavark, slirp4netns, passt —
  Ubuntu's podman dependency chain pulls in exactly the **rootless-friendly** networking stack:
  `slirp4netns`/`passt`, not `iptables`/`nftables`, neither of which is installed or installable
  as this user) but **failed at `dpkg`'s unpack step**: `dpkg: error: requested operation requires
  superuser privilege`. `sudo -n true` reported OK but was not applied to the install command in
  this run — untested whether `sudo apt-get install` or wrapping the whole install in
  `unshare --user --map-root-user` (so `dpkg`'s internal `chown(root,root)` calls succeed against
  the *mapped* root of a namespace we own) completes the install. Given 1.3's result (overlay-in-userns
  worked cleanly), this is very likely fixable but **was not proven end-to-end** — `podman --version`
  after the failed install still reports "not found."

**Net effect:** the pieces rootless Podman needs are individually present and working (userns,
overlay-in-userns, non-iptables networking deps resolve cleanly), but a stock installation path
does not complete unmodified, and no probe in this session got to `podman run hello-world`
succeeding. This is exactly consistent with what Fly's own community reports independently: people
"have asked about Docker and Podman support on Sprites and report having issues getting either to
run" ([Fly community](https://community.fly.io/t/docker-podman-support/27168)).

### 1.5 Recommended follow-up probes (NOT done here — scope/cost boundary of this pass)

1. Wrap the *entire* podman install (`apt-get`/`dpkg`) inside `unshare --user --map-root-user`
   and confirm `podman run hello-world` completes.
2. Re-run the `containment.ts` `CONTAINMENT_TARGETS` probes (`_api.internal:4280`, metadata IP
   ± encodings, 6PN peer, Flycast, Tigris) **from inside a nested rootless container** (i.e.
   through its `slirp4netns`/`passt` usermode network path), not just from the Sprite's own shell.
   G1 was verified 2026-06-30 for the Sprite's own network stack only (`FULL-EGRESS-ENABLEMENT.md`)
   — a nested container's usermode network stack is a new hop that has not been probed.
   This is a real requirement gap, not a formality: the security model is fail-closed by design.
3. Test whether `createCheckpoint`/`restoreCheckpoint` can persist a pre-installed runtime so the
   install cost is paid once per Machine (or once globally, if checkpoints are shareable), not
   repeated. Note PageSpace's driver does not use this API today.
4. Concurrency: multiple branch-containers in one Sprite competing for the Sprite's own
   `ramMB`/`cpus` caps — not load-tested.

---

## 2. Isolation statement

What a branch-container (a rootless Podman container nested inside a Sprite, per §1) isolates,
versus the containment invariants a Sprite itself must uphold (`containment.ts`,
`FULL-EGRESS-ENABLEMENT.md`):

**What it DOES isolate (by ordinary Linux namespace/cgroup semantics, TESTED as available):**
- Filesystem: its own root, via an overlay mount owned by its own mapped-root user namespace —
  writes inside the branch-container do not touch the Sprite's real `/` or sibling branches'
  checkouts.
- Process tree: its own PID namespace (`unshare --pid`).
- Hostname/IPC: its own UTS/IPC namespaces.
- A resource ceiling, if cgroup v2 delegation is wired per-container (controllers are present and
  delegated at the Sprite level; per-branch sub-delegation was not tested).

**What it does NOT isolate — and must not be assumed to (this is the part that matters for
security review):**
- **No second hardware boundary.** `/dev/kvm` is absent — TESTED. There is no nested
  Firecracker/KVM layer available to a Sprite, so a branch-container is *only* as isolated as
  Linux namespaces make it: same class of isolation as any container on a shared host kernel. A
  guest-kernel container-escape bug compromises the Sprite (and every other branch-container in
  it) — unlike Sprite-to-Sprite isolation, which genuinely is hardware/microVM-level per
  `FULL-EGRESS-ENABLEMENT.md`'s G1. Do not describe branch-container isolation to users or in
  security docs using the same language as Sprite isolation — they are different tiers.
- **Not a multi-tenant security boundary.** This is workspace/dependency isolation between
  branches of the *same* owner/Machine (matching the epic's own framing — "Branch = a docker
  container with that branch checked out" is about not having branch A's `node_modules`/env clash
  with branch B's, not about isolating different customers). It must never be marketed or relied
  on as isolating one user's code from another's.
- **Egress containment is UNVERIFIED for the nested path** (see §1.5.2). The Sprite-level
  deny-by-default/G1-verified containment does not, on its own, prove anything about what a
  `slirp4netns`/`passt`-backed container's traffic can reach — this needs its own probe before any
  egress is opened to a branch-container. Until then, the safe default is: branch-containers get
  **no** egress (or a network egress mode of `none`/loopback-only for `podman run`), independent of
  whatever policy the enclosing Sprite has, until the nested-path containment probe (§1.5.2) passes.
- **No privileged operations propagate outward.** The mapped-root identity inside a branch's own
  userns is fake root — it cannot mount over the Sprite's real filesystem, load kernel modules, or
  otherwise touch anything outside namespaces it created itself (TESTED: plain `mount`/`mount --bind`
  outside a fresh userns fails "must be superuser" even with the ambient capability set present).

---

## 3. Modal fit (READ — not probed live; no Modal credentials available in this environment)

Per `tasks/terminal.md`'s model, Modal is already slated as "beefy/GPU" substrate for later. For
Branches specifically, Modal is a much closer fit than Sprites out of the box:

- Modal has (Alpha) **Docker-in-Sandbox** support explicitly aimed at "coding agents who want to
  interact with development environments managed using Docker"
  ([Modal docs](https://modal.com/docs/guide/docker-in-sandboxes)).
- For full nested-container fidelity, Modal recommends its **VM Sandboxes** tier: Docker state is
  included in filesystem snapshots, and Docker features that need special handling under gVisor
  (e.g. inter-container networking) "work normally," including support for custom init systems
  like systemd ([Modal docs](https://modal.com/docs/guide/vm-sandboxes)).
- This means Modal's VM Sandboxes give a real second isolation layer (an actual VM per sandbox)
  that Sprites do not expose today (§1.2, §2) — closer in spirit to what "Branch = a docker
  container" implies as a safety boundary.

**Read as:** Modal is very plausibly the correct backing substrate for the Branches tier, not a
distant fallback. This raises the priority of the Machine-substrate abstraction PR — it is the
thing that lets Branches ship against Modal while Terminal/Epic 1 keeps shipping against Sprites,
without the two being coupled.

---

## 4. Recommendation

1. Treat the Machine-substrate abstraction (Sprite / Modal behind one seam) as a **hard
   prerequisite**, sequenced before or alongside the start of Branches implementation work — not
   an optional later refactor.
2. Do not attempt to make raw Sprites do docker-per-branch by brute force (rootless-bootstrap
   scripting, custom install-and-checkpoint flows) as the primary path — it is unproven,
   Fly-community-reported as painful, and buys an inferior isolation tier (§2) compared to what
   Modal already ships.
3. Before any branch-container gets network egress, run the nested-path containment probe
   (§1.5.2) and gate it the same way `SANDBOX_CONTAINMENT_VERIFIED` gates full-egress Sprites
   today — fail-closed, no exceptions.
4. If Sprites are still desired for Branches for cost/latency reasons, budget real engineering
   time for: (a) proving the rootless-install path end-to-end (§1.5.1), (b) a checkpoint-based
   install-once story (§1.5.3), and (c) the nested-egress containment probe (§1.5.2) — this is not
   a small follow-up, it is most of a project.

---

## Appendix: probe methodology (for reproducibility)

Live probes ran against three throwaway Sprites (`docker-probe-*`, `docker-probe2-*`,
`docker-probe3-*`), created and destroyed within this session using the production
`SPRITES_API_TOKEN` (read from the already-deployed Fly secret on `pagespace-web` via
`fly ssh console -a pagespace-web -C "printenv SPRITES_API_TOKEN"` — the token value itself is not
reproduced here) and the SDK cached at
`~/.bun/install/cache/@fly/sprites@0.0.1-rc37`, driven directly (not through PageSpace's own
`sandbox-client/sprites.ts`, so the usual deny-by-default egress lockdown did **not** apply to
these probe Sprites — see §1.4). No production code path or app data was touched; each Sprite was
deleted (`sprite.delete()`) immediately after its checks ran. No files under this probe were
committed to the repo other than this decision doc.

Representative check invocation shape (all checks used this form to get real shell semantics,
since `sprite.exec()`/`spawn()` split args with no host shell by default):

```js
const { stdout, stderr, exitCode } = await sprite.execFile('sh', ['-c', script], {
  timeout: 20000,
  maxBuffer: 1024 * 1024,
});
```

Sources cited:
- [Fly community — "Docker/Podman support?"](https://community.fly.io/t/docker-podman-support/27168) (accessed 2026-07-06)
- [Modal Docs — Docker in Sandboxes](https://modal.com/docs/guide/docker-in-sandboxes) (accessed 2026-07-06)
- [Modal Docs — VM Sandboxes](https://modal.com/docs/guide/vm-sandboxes) (accessed 2026-07-06)
- `@fly/sprites@0.0.1-rc37` SDK source (`dist/types.d.ts`, `dist/sprite.d.ts`, `README.md`), the exact version pinned in `packages/lib/package.json` / `apps/web/package.json`
- `packages/lib/src/services/sandbox/sandbox-client/sprites.ts`, `containment.ts`, `FULL-EGRESS-ENABLEMENT.md` (this repo)
