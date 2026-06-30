# Full-Egress Sandbox — Enablement Checklist (G-Gates)

Both agent sandboxes and human terminals run **full (open) egress**. The egress
allowlist is **not** the security boundary and never was — Sprites egress policy is
DNS-name-only and cannot match IP-literal/6PN egress. The boundary is:

1. **Firecracker microVM isolation** (Sprites: hardware-level, per-conversation, destroyed on stop).
2. **Verified containment** off the Fly internal surface (this checklist).
3. **Minimal injected secrets** (`buildSandboxEnv` is allowlist-only; assume anything injected can leak under full egress).
4. **Explicit internal-surface deny** in open-mode policy (`buildInternalSurfaceDenyRules`) — DNS-layer defense-in-depth, not the boundary.

The injection-detection seam (`screenToolOutput`) is **defense-in-depth only,
fail-open** — it annotates, never blocks, never gates network. Published
false-negative rates run ~29% in-distribution to ~100% under adaptive evasion, so
it is not load-bearing.

---

## HARD G-GATES — all must pass before `CODE_EXECUTION_ENABLED=true` in any env

### G1 — Containment proven (BLOCKING)

Run the containment probes **inside a live Sprite** against the real backing
topology and feed the results to `assessContainment` (`containment.ts`). It MUST
return `{ contained: true, breaches: [] }`. The production enablement path wires
`decideFullEgressEnablement` so provisioning is refused (`containment_unverified`)
whenever this is not verified.

Each of these targets MUST be **unreachable** from a Sprite:

| Target | Probe intent |
|--------|--------------|
| `_api.internal:4280` | Fly Machines API over 6PN |
| `6pn-peer` (a sibling app on the org 6PN, `fdaa::/8`) | lateral movement to other apps |
| `169.254.169.254` + decimal `2852039166` + hex `0xa9fea9fe` | cloud metadata IP (and SSRF-bypass encodings) |
| `flycast` | Flycast internal services |
| `tigris` | object-storage internal endpoint |

If any target is **reachable**, containment is breached → the documented fix is a
**dedicated/unique custom 6PN per sandbox** (`fly apps create --network <unique>`),
which removes the route to `_api.internal` and sibling apps. Confirm Sprites VMs are
not on the PageSpace org 6PN.

### G2 — Egress IP attribution (BLOCKING for prod)

Confirm what source IP Sprite outbound uses and that it is **isolated from
production's shared NAT pool**. Allocate a dedicated egress IP for the sandbox pool
and set `SANDBOX_EGRESS_IP_TAG` (see `egress-ip.ts` deploy note;
`fly machine egress ip allocate`). Until done, `resolveEgressIpTag` reports
`dedicated: false` (degraded) — a hijacked sandbox can blocklist a shared IP and
trigger whole-account AUP suspension.

### G3 — Outbound throttle active

Confirm `outboundThrottleDecision` limits are wired at the egress accounting path —
our only backstop, since Fly documents no automated outbound-abuse protection.

### G4 — Read-side host-memory bound

(Pre-existing) The fs read materializes whole files before truncation; bound it at
the SDK boundary before flag-on.

---

## Empirical probes to run (operational — needs `SPRITES_API_TOKEN` + staging org)

1. **Internal reachability:** from a live Sprite, attempt each G1 target; expect all
   to fail. Feed results through `parseContainmentProbe` → `assessContainment`.
2. **Egress IP:** from a live Sprite, observe the outbound source IP and compare to
   production apps' egress IP. They must differ.
