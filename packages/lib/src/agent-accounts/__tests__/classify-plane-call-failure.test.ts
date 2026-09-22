/**
 * L2·G2 review HIGH-2 — what the web process may tell a model when a call to
 * the credential plane fails. For `execute`, a timeout, a dropped connection
 * or a 5xx after the request was handed over means the plane may still have
 * sent it upstream: the answer is `outcome_unknown` ("do not retry
 * automatically"), never "nothing was sent". Only a failure that provably
 * precedes the plane receiving the call — connection refused, unresolvable
 * host — is `plane_unavailable`; a 4xx is the plane refusing the call before
 * executing it (`refused`). For `put` and `revoke`, an unknown outcome is
 * reported as `plane_unavailable` and the caller keeps its state.
 */
import { describe, expect, it } from 'vitest';
import { classifyPlaneCallFailure } from '../classify-plane-call-failure';

describe('classifyPlaneCallFailure', () => {
  it('given execute failing after the call may have reached the plane, should report outcome_unknown', () => {
    const actual = [
      classifyPlaneCallFailure({ route: 'execute', failure: { kind: 'timeout' } }),
      classifyPlaneCallFailure({ route: 'execute', failure: { kind: 'network', code: 'ECONNRESET' } }),
      classifyPlaneCallFailure({ route: 'execute', failure: { kind: 'status', status: 502 } }),
      classifyPlaneCallFailure({ route: 'execute', failure: { kind: 'network', code: null } }),
    ];
    const expected = ['outcome_unknown', 'outcome_unknown', 'outcome_unknown', 'outcome_unknown'];
    expect(actual).toEqual(expected);
  });

  it('given execute failing before the plane could receive it, should report plane_unavailable', () => {
    const actual = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].map((code) => classifyPlaneCallFailure({ route: 'execute', failure: { kind: 'network', code } }));
    const expected = ['plane_unavailable', 'plane_unavailable', 'plane_unavailable'];
    expect(actual).toEqual(expected);
  });

  it('given the plane answering 4xx to execute, should report refused — it rejected the call before executing', () => {
    const actual = [400, 401, 413].map((status) => classifyPlaneCallFailure({ route: 'execute', failure: { kind: 'status', status } }));
    const expected = ['refused', 'refused', 'refused'];
    expect(actual).toEqual(expected);
  });

  it('given put or revoke failing any way, should report plane_unavailable', () => {
    const actual = [classifyPlaneCallFailure({ route: 'put', failure: { kind: 'timeout' } }), classifyPlaneCallFailure({ route: 'revoke', failure: { kind: 'status', status: 500 } })];
    const expected = ['plane_unavailable', 'plane_unavailable'];
    expect(actual).toEqual(expected);
  });
});
