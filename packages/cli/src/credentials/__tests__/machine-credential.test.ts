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
