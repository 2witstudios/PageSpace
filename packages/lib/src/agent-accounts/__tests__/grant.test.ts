import { describe, it } from 'vitest';

// ADR 0004 §8 assertions 1–12, 19 — RED at G1b before verify-grant.ts exists (Control Board §7.2).

describe('parseGrant (ADR 0004 F1)', () => {
  it.todo('given a grant with any field absent, undefined, or an extra key, should return malformed before any other check runs (no signature call observed) [0004 §8.1]');
  it.todo('given exp < iat, should return malformed, not ttl_too_long [0004 §8.2]');
  it.todo('given nbf > iat, should return malformed [0004 F1]');
  it.todo('given aud relay-runner with sandbox null, or sandbox set with any other aud, should return malformed [0006 §8.1]');
  it.todo('given a RunId where a SandboxInstanceId is expected, should fail typecheck (@ts-expect-error brand test) [0004 §8.3]');
});

describe('verifyGrant deny order (ADR 0004 §6 F1→F17)', () => {
  it.todo('given a grant signed with the env-bridge key, should return bad_signature [0004 §8.4]');
  it.todo('given aud of another channel, should return wrong_audience before the signature is checked [0004 §8.4]');
  it.todo('given presenter.channel !== aud, should return wrong_audience [0004 F2]');
  it.todo('given callerCeiling.allowedDriveIds=[d1] and an account in drive d2, should return ceiling before any account fact is consulted [0004 §8.5]');
  it.todo('given callerCeiling.allowedDriveIds=[], should admit every drive [0004 §8.5]');
  it.todo('given tenantId differing from the account row, should return tenant_mismatch [0004 F4]');
  it.todo('given a valid unused grant whose agentPageId differs from the presenter current run, should return principal_mismatch before any version or delegation fact [0004 §8.20; PR #2637 P1]');
  it.todo('given a grant whose conversationId or runId differs from the presenter current run, should return principal_mismatch [0004 §8.20]');
  it.todo('given a grant whose human.userId differs from the acting human of the run, should return principal_mismatch [0004 §8.20]');
  it.todo('given ExpectedBinding, should carry the CURRENT human/agentPageId/conversationId/runId from the presenter context, never from the grant (type-level) [0004 §2.1]');
  it.todo('given credentialVersion one behind current, should return version_mismatch [0004 §8.6]');
  it.todo('given expected.accountStatus needs_reauth, revoked or deleted and an otherwise valid grant, should return account_not_active before version_mismatch (table over the three statuses × current and stale credentialVersion) [0004 §8.28; G1a review H4]');
  it.todo('given expected.accountStatus active, should pass the status check [0004 §8.28]');
  it.todo('given policyVersion one behind current, should return policy_epoch [0004 §8.6]');
  it.todo('given human.sessionId null and delegationId null, should return no_delegation [0004 §8.7]');
  it.todo('given an expired or revoked delegation fact, should return no_delegation [0004 §8.7]');
  it.todo('given a live delegation fact for this account whose agentPageId names another agent page than grant.agentPageId, should return no_delegation [0004 §8.27; G1a review H3]');
  it.todo('given a live delegation fact whose delegatedBy is another user than grant.human.userId, should return no_delegation [0004 §8.27]');
  it.todo('given a live delegation fact whose delegationId, accountId, agentPageId and delegatedBy all match the grant, should pass the delegation check [0004 §8.27]');
  it.todo('given a request body differing by one byte from the digested one, should return digest_mismatch [0004 §8.8]');
  it.todo('given headers reordered, host uppercased, or :443 omitted, should verify ok (digest identical) [0004 §8.8]');
  it.todo('given operation differing from the presented request operation, should return digest_mismatch [0004 F8]');
  it.todo('given sandbox.generation one behind the presenter binding, should return generation_mismatch (restored-sandbox case) [0004 §8.9]');
  it.todo('given expected.sandbox null (binding unavailable), should return generation_mismatch, never ok [0006 §8.3]');
  it.todo('given exp - iat = 15 min + 1 ms, should return ttl_too_long [0004 §8.10]');
  it.todo('given now < nbf, should return not_yet_valid [0004 §8.10]');
  it.todo('given iat > now + 30 s, should return clock_skew [0004 F10]');
  it.todo('given now > exp, should return expired [0004 F10]');
  it.todo('given every pairwise two-fault input, should return the earlier reason in the fixed order F1→F17 (table test) [0004 §8.10]');
  it.todo('given nonceState consumed, should return replayed [0004 §8.11]');
  it.todo('given nonceState unknown, should return replay_store_unavailable, never assume fresh [0004 §8.11]');
  it.todo('given a concrete approval fact with consumedByGrantId null, should return approval_mismatch [0004 §8.21; PR #2637 P1]');
  it.todo('given a concrete approval fact consumed by another grantId, should return approval_mismatch [0004 §8.21]');
  it.todo('given a concrete approval fact whose consumedByGrantId equals this grantId, should verify ok [0004 §8.21]');
  it.todo('given approvalId naming an approval bound to a different digest, should return approval_mismatch [0004 F14]');
  it.todo('given operation class irreversible or privilege with approvalId policy, should return approval_mismatch [0004 §8.12]');
  it.todo('given kind password with aud other than browser-worker, should return kind_not_resolvable [0004 F17]');
  it.todo('given kind session with aud http-executor and sessionHttp false, should return kind_not_resolvable [0004 §8.23; PR #2637 P1]');
  it.todo('given a grant without bindingDigest or sessionHttp, should return malformed (every field required) [0004 §8.24]');
  it.todo('given a deny toward an untrusted caller, should collapse to one constant-shape refusal with the reason in audit only [0004 F16]');
});

describe('verifyGrant input type (ADR 0006 §8.4)', () => {
  it.todo('given VerifyGrantInput, should have no key matching /header|ip|forwarded|sprite/i except sandbox (type-level test)');
});

describe('nonce recorded only on ok — adapter (ADR 0004 §8.11)', () => {
  it.todo('given a grant failing bad_signature, should leave the replay store untouched');
  it.todo('given a grant verifying ok, should record the nonce exactly once');
});

describe('mutation pairs (Control Board §7.4; ADR 0004 §8.19)', () => {
  it.todo('given the digest compare broken by line index, should go RED on §8.8; restored, GREEN');
  it.todo('given the nonce-only-on-ok rule broken, should go RED on §8.11; restored, GREEN');
  it.todo('given the ceiling-first rule broken, should go RED on §8.5; restored, GREEN');
  it.todo('given the aud check broken, should go RED on §8.4; restored, GREEN');
});
