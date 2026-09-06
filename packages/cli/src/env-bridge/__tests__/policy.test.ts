import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { defaultPolicyPath, describePolicyRefusal, loadMachinePolicy, type PolicyFileStat, type PolicyLoaderDeps } from '../policy.js';

const VALID = {
  mode: 'allowlist',
  principals: ['user_1'],
  ops: ['exec', 'fs_read'],
  roots: ['/Users/me/proj'],
  envAllowlist: ['CI'],
  maxBytes: 4096,
  maxTimeoutMs: 5_000,
};
const UID = 501;

interface Overrides {
  readonly content?: string | null;
  readonly stat?: PolicyFileStat | null | (() => PolicyFileStat | null);
  readonly readFile?: PolicyLoaderDeps['readFile'];
}

function deps(overrides: Overrides = {}): PolicyLoaderDeps {
  const { content: contentOverride, stat: statOverride, ...rest } = overrides;
  const content = contentOverride === undefined ? JSON.stringify(VALID) : contentOverride;
  const statValue = statOverride === undefined ? { uid: UID, mode: 0o100600 } : statOverride;
  return {
    path: '/home/me/.pagespace/env-policy.json',
    uid: UID,
    stat: typeof statValue === 'function' ? statValue : () => statValue,
    readFile: () => {
      if (content === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return content;
    },
    ...rest,
  };
}

describe('loadMachinePolicy — ~/.pagespace/env-policy.json → MachinePolicy | null (invariant 5: missing/invalid ⇒ deny-all)', () => {
  it('given a valid, owner-only file, should return the parsed policy, no reason, and the SHA-256 digest of the file bytes', () => {
    const loaded = loadMachinePolicy(deps());
    expect(loaded.policy).toEqual(VALID);
    expect(loaded.reason).toBeNull();
    expect(loaded.digest).toBe(createHash('sha256').update(JSON.stringify(VALID)).digest('hex'));
  });

  it('given no file, should return null with reason "missing" and an empty digest', () => {
    const loaded = loadMachinePolicy(deps({ stat: null, content: null }));
    expect(loaded.policy).toBeNull();
    expect(loaded.reason).toBe('missing');
    expect(loaded.digest).toBe('');
  });

  it('given a file owned by another user, should treat it as MISSING (null) with reason "wrong_owner" — otherwise any local process could widen the policy', () => {
    const loaded = loadMachinePolicy(deps({ stat: { uid: 0, mode: 0o100600 } }));
    expect(loaded.policy).toBeNull();
    expect(loaded.reason).toBe('wrong_owner');
  });

  it('given a group-writable file, should return null with reason "writable_by_others"', () => {
    expect(loadMachinePolicy(deps({ stat: { uid: UID, mode: 0o100620 } })).reason).toBe('writable_by_others');
    expect(loadMachinePolicy(deps({ stat: { uid: UID, mode: 0o100620 } })).policy).toBeNull();
  });

  it('given a world-writable file, should return null with reason "writable_by_others"', () => {
    expect(loadMachinePolicy(deps({ stat: { uid: UID, mode: 0o100602 } })).reason).toBe('writable_by_others');
  });

  it('given a file readable by others but writable only by the owner, should accept it (the policy is not a secret)', () => {
    expect(loadMachinePolicy(deps({ stat: { uid: UID, mode: 0o100644 } })).policy).toEqual(VALID);
  });

  it('given a stat that throws (EACCES), should fail closed as "unreadable", never as a policy', () => {
    const loaded = loadMachinePolicy(
      deps({
        stat: () => {
          throw new Error('EACCES');
        },
      }),
    );
    expect(loaded.policy).toBeNull();
    expect(loaded.reason).toBe('unreadable');
  });

  it('given a file that is not JSON, should return null with reason "invalid_json"', () => {
    const loaded = loadMachinePolicy(deps({ content: '{ mode: ask' }));
    expect(loaded.policy).toBeNull();
    expect(loaded.reason).toBe('invalid_json');
    expect(loaded.digest).toBe('');
  });

  it('given JSON the strict parser refuses (unknown field, relative root), should return null with reason "invalid_schema" — never a partial or default-permissive policy', () => {
    expect(loadMachinePolicy(deps({ content: JSON.stringify({ ...VALID, extra: true }) })).reason).toBe('invalid_schema');
    expect(loadMachinePolicy(deps({ content: JSON.stringify({ ...VALID, roots: ['relative'] }) })).reason).toBe('invalid_schema');
    expect(loadMachinePolicy(deps({ content: JSON.stringify({ ...VALID, mode: 'allow-everything' }) })).policy).toBeNull();
  });

  it('given a readFile that throws after a good stat, should return "unreadable"', () => {
    const loaded = loadMachinePolicy(
      deps({
        readFile: () => {
          throw new Error('EIO');
        },
      }),
    );
    expect(loaded.reason).toBe('unreadable');
  });
});

describe('defaultPolicyPath', () => {
  it('should honour PAGESPACE_ENV_POLICY, else ~/.pagespace/env-policy.json', () => {
    expect(defaultPolicyPath({ PAGESPACE_ENV_POLICY: '/etc/ps/policy.json' }, '/home/me')).toBe('/etc/ps/policy.json');
    expect(defaultPolicyPath({}, '/home/me')).toBe('/home/me/.pagespace/env-policy.json');
  });
});

describe('describePolicyRefusal', () => {
  it('should say WHY the policy is treated as missing and how to fix it, per reason', () => {
    expect(describePolicyRefusal('missing', '/p')).toMatch(/no policy file at \/p/i);
    expect(describePolicyRefusal('wrong_owner', '/p')).toMatch(/owned by another user/i);
    expect(describePolicyRefusal('writable_by_others', '/p')).toMatch(/chmod 600 \/p/);
    expect(describePolicyRefusal('invalid_json', '/p')).toMatch(/not valid JSON/i);
    expect(describePolicyRefusal('invalid_schema', '/p')).toMatch(/not a valid policy/i);
    expect(describePolicyRefusal('unreadable', '/p')).toMatch(/could not be read/i);
  });
});
