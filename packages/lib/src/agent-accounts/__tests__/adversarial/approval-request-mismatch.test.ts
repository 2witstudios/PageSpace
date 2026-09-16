import { describe, it } from 'vitest';

// Threat model A2, B-4 (ASI09/ASI06). Approve one representation, execute the same.

describe('adversarial: approval-request-mismatch', () => {
  it.todo('given an approval bound to digest X and a grant request for digest Y, should return approval_mismatch');
  it.todo('given an approval for PUT /x/foo%3Bbar and an executed PUT /x/foo;bar (likewise %2B/+, %40/@, %3D/=), should return digest_mismatch — decoding path segments must never collapse them [0004 §3.2 second amendment]');
  it.todo('given an approval consumed once, should refuse a second issuance against it');
  it.todo('given an approval row recorded for account X (e.g. inserted by a DB writer) and a grant for account Y with the same digest, should return approval_mismatch at verifyGrant [G1a review M3]');
  it.todo('given an approval obtained for op mint-like A, should not redeem for op B with identical arguments (op discriminator in the digest)');
  it.todo('given a model-generated "the user approved" text, should carry no authority (no approval row, requirement stays concrete)');
  it.todo('given an always policy, should never cover irreversible or privilege classes');
  it.todo('given a tool layer that labels a DELETE as a read operation, should have no field to say so — the class comes from the OperationRegistry and an unmatched DELETE is unknown, so a read-only always policy does not cover it [G1a review M1]');
  it.todo('given an approval subject, should be rendered from the canonical request only (no page/summary/model text)');
  it.todo('given two requests identical except ?force=true, should render subjects that differ in query — the human sees every digest-bound part that changes what the request does [G1a review H5]');
});
