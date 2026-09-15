/**
 * ADR 0005 §2.3, §10.6 — RED at G1b-store before `decide-cas.ts` existed.
 */
import { describe, it, expect } from 'vitest';
import type { CredentialVersion, TenantId, AccountOwnerRef, PolicyVersion } from '@pagespace/db/schema/agent-accounts';
import type { CanonicalOrigin } from '../../canonical-request';
import type { PlaneBindings } from '../store-adapter';
import { decideCas } from '../decide-cas';

const bindings: PlaneBindings = {
  tenantId: 'user:u1' as TenantId,
  ownerRef: { kind: 'user', userId: 'u1' } as AccountOwnerRef,
  allowedOrigins: ['https://example.com' as CanonicalOrigin],
  policyVersion: 1 as PolicyVersion,
  kind: 'api_key',
};

describe('decideCas', () => {
  it('given observedBefore not equal to expectedVersion, should return version_conflict', () => {
    const actual = decideCas({
      expectedVersion: 3 as CredentialVersion,
      observedBefore: 4 as CredentialVersion,
      observedAfter: 5 as CredentialVersion,
      bindingsAfter: bindings,
      bindingsWritten: bindings,
    });
    expect(actual).toEqual({ outcome: 'version_conflict' });
  });

  it('given observedAfter not equal to observedBefore + 1, should return write_unverified', () => {
    const actual = decideCas({
      expectedVersion: 1 as CredentialVersion,
      observedBefore: 1 as CredentialVersion,
      observedAfter: 3 as CredentialVersion,
      bindingsAfter: bindings,
      bindingsWritten: bindings,
    });
    expect(actual).toEqual({ outcome: 'write_unverified' });
  });

  it('given bindingsAfter not equal to bindingsWritten, should return write_unverified', () => {
    const tampered: PlaneBindings = { ...bindings, policyVersion: 2 as PolicyVersion };
    const actual = decideCas({
      expectedVersion: 1 as CredentialVersion,
      observedBefore: 1 as CredentialVersion,
      observedAfter: 2 as CredentialVersion,
      bindingsAfter: tampered,
      bindingsWritten: bindings,
    });
    expect(actual).toEqual({ outcome: 'write_unverified' });
  });

  it('given a consistent read-write-verify, should return commit with the new version', () => {
    const actual = decideCas({
      expectedVersion: 1 as CredentialVersion,
      observedBefore: 1 as CredentialVersion,
      observedAfter: 2 as CredentialVersion,
      bindingsAfter: bindings,
      bindingsWritten: bindings,
    });
    expect(actual).toEqual({ outcome: 'commit', version: 2 });
  });

  it('given a create (expectedVersion null, no prior version), should commit at version 1', () => {
    const actual = decideCas({
      expectedVersion: null,
      observedBefore: null,
      observedAfter: 1 as CredentialVersion,
      bindingsAfter: bindings,
      bindingsWritten: bindings,
    });
    expect(actual).toEqual({ outcome: 'commit', version: 1 });
  });

  it('given a create attempted against an already-existing secret, should return version_conflict', () => {
    const actual = decideCas({
      expectedVersion: null,
      observedBefore: 1 as CredentialVersion,
      observedAfter: 2 as CredentialVersion,
      bindingsAfter: bindings,
      bindingsWritten: bindings,
    });
    expect(actual).toEqual({ outcome: 'version_conflict' });
  });
});
