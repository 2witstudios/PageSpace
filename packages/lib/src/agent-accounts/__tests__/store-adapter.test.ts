import { describe, it } from 'vitest';

// ADR 0005 §8 + §10 — RED at G1b before decide-store-write.ts / decide-resolve.ts / infisical-store-adapter.ts exist.

describe('agent_accounts schema (ADR 0005 §10.1)', () => {
  it.todo('given packages/db/src/schema/agent-accounts.ts, should contain no column name matching /credential|secret|token|password/ except the kind literal (source-level test)');
});

describe('deriveTenantId (ADR 0005 §10.2)', () => {
  it.todo('given a user-owned account, should return user:<userId>');
  it.todo('given an agent-page-owned account, should return drive:<driveId>');
  it.todo('given the same owner twice, should return the same id (pure, idempotent)');
});

describe('decideResolve (ADR 0005 F1–F5, F10; §10.3–5)', () => {
  it.todo('given kind password and channel http-executor, should return kind_not_resolvable; and ResolvableBy<http-executor> should exclude password (@ts-expect-error) [§10.3]');
  it.todo('given kind password and channel browser-worker, should return ok [§10.3]');
  it.todo('given a grant whose aud is not an executor channel, should be unrepresentable by type and kind_not_resolvable if reached [F1]');
  it.todo('given version one behind current inside rotationGraceMs, should return ok for a grant that named the old version [§10.4]');
  it.todo('given version one behind current outside rotationGraceMs, should return version_mismatch [§10.4]');
  it.todo('given stored bindings whose policyVersion differs from those the grant bindingDigest was computed over, should return binding_mismatch [§10.5; PR #2637 P1]');
  it.todo('given stored bindings with a changed ownerRef or allowedOrigins versus the grant bindingDigest, should return binding_mismatch [§10.5]');
  it.todo('given stored bindings differing only in key order from those digested, should compare equal (digestBindings is canonical) [§10.5]');
  it.todo('given stored bindings whose policyDigest covers a wider approval policy scope, one more resourceRestrictions repo, or one more bound agent page than the grant bindingDigest, with policyVersion unchanged, should return binding_mismatch [§10.20; G1a review H1]');
  it.todo('given decideResolve, should consult no main-DB fact — the bindings check is digestBindings(stored) versus grant.bindingDigest with the injected hash [0005 §2.4]');
  it.todo('given resolve of an oauth2 ref by http-executor or relay-runner, should return material with no refreshToken key (type: MaterialForChannel lacks it; runtime: adapter strips) [§10.16; PR #2637 P1]');
  it.todo('given resolve of an oauth2 ref by refresh-worker, should return material including refreshToken [§10.16]');
  it.todo('given resolve of a session ref by http-executor, should not compile (ResolvableBy excludes session) and return kind_not_resolvable if reached [§10.17; PR #2637 P1]');
  it.todo('given resolveSessionOverHttp with a grant whose sessionHttp is false, should not compile; with true, should return ok [§10.17]');
  it.todo('given the authority issuing a grant, bindingDigest should equal digestBindings over the bindings it read [§10.19]');
  it.todo('given stored null (wrong-tenant identity or absent), should return not_found [F5]');
  it.todo('given revokedAt set, should return revoked regardless of version [F10]');
});

describe('digestPlaneScope (ADR 0005 §2.4, §10.20)', () => {
  it.todo('given the same scope with boundAgentPageIds and allowedOrigins in a different order, should return the same PolicyDigest');
  it.todo('given a scope differing in approvalPolicy, resourceRestrictions, boundAgentPageIds or allowedOrigins, should return a different PolicyDigest');
  it.todo('given the injected hash, should be SHA3-256 over canonicalJson(scope) — the authority and the plane derive identical bytes');
});

describe('decideStoreWrite — our CAS (ADR 0005 §10.6)', () => {
  it.todo('given observedBefore !== expectedVersion, should return version_conflict');
  it.todo('given observedAfter !== observedBefore + 1, should return write_unverified');
  it.todo('given bindingsAfter !== bindingsWritten, should return write_unverified');
  it.todo('given a consistent read-write-verify, should return commit with the new version');
});

describe('planStoreIdentity (ADR 0005 §10.10; parameterized on D-29)', () => {
  it.todo('given model A and tier free, should return blastRadius tier');
  it.todo('given model A and tier paid, should return blastRadius tenant');
  it.todo('given model B, should return blastRadius tenant for both tiers');
  it.todo('given model C, should return blastRadius all');
});

describe('infisical-store-adapter — integration against a sandbox project with synthetic material (ADR 0005 §10.7–9)', () => {
  it.todo('given put then describe, should return version and bindings and never the material');
  it.todo('given resolve with a wrong-tenant identity, should return not_found');
  it.todo('given resolve after revoke, should return revoked');
  it.todo('given delete then describe, should return not_found');
  it.todo('given two concurrent rotate calls with the same expectedVersion (*.integration.test.ts against :5433 for the advisory lock), should commit exactly one and return version_conflict for the other');
  it.todo('given delete whose upstream revocation is unsupported, should return { removed: true, upstream: unsupported } and the row should read the same');
});

describe('web process holds no reading identity (ADR 0005 §10.11)', () => {
  it.todo('given the web server env schema, should declare no store reading identity variable');
  it.todo('given the web bundle import graph, should not reach the resolve export of the adapter module');
});

describe('mutation pairs (ADR 0005 §10.15)', () => {
  it.todo('given the aud gate in decideResolve broken by line index, should go RED; restored, GREEN');
  it.todo('given the password kind_not_resolvable rule broken, should go RED; restored, GREEN');
  it.todo('given the bindings compare broken, should go RED; restored, GREEN');
  it.todo('given the expectedVersion check broken, should go RED; restored, GREEN');
});
