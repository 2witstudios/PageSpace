import { describe, expect, it } from 'vitest';
import {
  credentialSecret,
  emptyCredentialsFile,
  getHost,
  machineProfileName,
  parseCredentialsFile,
  serializeCredentialsFile,
  upsertHost,
  type MachineHostCredential,
} from '../serialize.js';

const MACHINE: MachineHostCredential = {
  kind: 'machine',
  privateKey: 'MC4CAQAwBQYDK2VwBCIEIA',
  enrollmentId: 'enr_1',
  envId: 'env_1',
  serverPublicKey: 'MCowBQYDK2VwAyEA',
  serverKeyId: 'k1',
  scopes: [],
  createdAt: '2026-09-05T10:00:00.000Z',
};

describe('the machine credential — the private key lives ONLY in the credential store', () => {
  it('should round-trip through the credentials file under its env profile, alongside a login on the same host', () => {
    const host = 'https://pagespace.ai';
    let file = upsertHost(emptyCredentialsFile(), host, { kind: 'static', token: 'mcp_abc', scopes: ['account'], createdAt: MACHINE.createdAt });
    file = upsertHost(file, host, MACHINE, machineProfileName(MACHINE.enrollmentId));
    const reparsed = parseCredentialsFile(serializeCredentialsFile(file));
    expect(getHost(reparsed, host, 'env:enr_1')).toEqual(MACHINE);
    expect(getHost(reparsed, host)?.kind).toBe('static');
  });

  it('should treat the private key as the credential\'s secret (so listings prefix it and nothing prints it whole)', () => {
    expect(credentialSecret(MACHINE)).toBe(MACHINE.privateKey);
  });

  it('given a machine entry missing any identity field, should refuse the file as malformed rather than load a half-identity', () => {
    for (const field of ['privateKey', 'enrollmentId', 'envId', 'serverPublicKey', 'serverKeyId'] as const) {
      const broken = { ...MACHINE, [field]: '' };
      const raw = JSON.stringify({ version: 2, hosts: { 'https://pagespace.ai': { profiles: { 'env:enr_1': broken } } } });
      expect(() => parseCredentialsFile(raw), field).toThrow(/malformed/);
    }
  });

  it('should name the profile env:<enrollmentId>, disjoint from key names a user could pick', () => {
    expect(machineProfileName('enr_1')).toBe('env:enr_1');
  });
});

/**
 * HARDENING B, leaves B1 and B5 — the owner's pinned passkeys ride the machine
 * credential (public keys only), are written once at enrolment, and a
 * pinning that is not exactly right is DROPPED rather than trusted.
 */
describe('the pinned owner credentials on a machine credential', () => {
  const PINNED = { rpId: 'pagespace.test', origin: 'https://pagespace.test', credentials: [{ credentialId: 'cred-a', publicKeyCose: 'cose-a' }] };
  const withPinned: MachineHostCredential = { ...MACHINE, ownerApproval: PINNED };
  const roundTrip = (credential: unknown) => {
    const raw = JSON.stringify({ version: 2, hosts: { 'https://pagespace.ai': { profiles: { 'env:enr_1': credential } } } });
    return getHost(parseCredentialsFile(raw), 'https://pagespace.ai', 'env:enr_1') as MachineHostCredential | null;
  };

  it('round-trips through the credentials file beside the pinned SERVER key — the same trust-on-first-use moment, both directions', () => {
    const file = upsertHost(emptyCredentialsFile(), 'https://pagespace.ai', withPinned, machineProfileName('enr_1'));
    const reparsed = parseCredentialsFile(serializeCredentialsFile(file));
    expect(getHost(reparsed, 'https://pagespace.ai', 'env:enr_1')).toEqual(withPinned);
  });

  it('carries no secret: public keys only, so the pinning adds nothing to lose from this file', () => {
    expect(JSON.stringify(withPinned.ownerApproval)).not.toContain(MACHINE.privateKey);
    expect(Object.keys(PINNED.credentials[0]!)).toEqual(['credentialId', 'publicKeyCose']);
  });

  it('an EMPTY pinned set survives the round trip — the machine must be able to tell "you have no passkey" from "nothing was ever pinned"', () => {
    const empty = roundTrip({ ...MACHINE, ownerApproval: { ...PINNED, credentials: [] } });
    expect(empty?.ownerApproval).toEqual({ ...PINNED, credentials: [] });
    expect(roundTrip(MACHINE)?.ownerApproval).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['not an object', 'nope'],
    ['a blank rpId', { ...PINNED, rpId: '' }],
    ['a blank origin', { ...PINNED, origin: '' }],
    ['credentials that are not an array', { ...PINNED, credentials: {} }],
    ['a null credential', { ...PINNED, credentials: [null] }],
    ['a credential with no public key', { ...PINNED, credentials: [{ credentialId: 'c' }] }],
    ['a credential with a blank id', { ...PINNED, credentials: [{ credentialId: '', publicKeyCose: 'k' }] }],
  ])('given a pinning that is %s, should DROP it (chat approvals refused) rather than load a partial trust — and still load the machine identity', (_label, ownerApproval) => {
    const loaded = roundTrip({ ...MACHINE, ownerApproval });
    expect(loaded?.ownerApproval).toBeUndefined();
    // Dropping the pinning is strictly STRICTER; it must not also strand the machine.
    expect(loaded?.privateKey).toBe(MACHINE.privateKey);
  });
});
