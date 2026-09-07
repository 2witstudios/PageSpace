import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { defaultPolicyPath, describePolicyRefusal, loadMachinePolicy, openPolicyFile, type OpenedPolicyFile, type PolicyLoaderDeps } from '../policy.js';

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
  readonly stat?: { uid: number; mode: number } | null | (() => { uid: number; mode: number } | null);
  readonly readFile?: () => string;
}

/** Models the ONE-fd adapter: the file is opened once; owner/mode and content come from that open. */
function deps(overrides: Overrides = {}): PolicyLoaderDeps {
  const { content: contentOverride, stat: statOverride, readFile } = overrides;
  const content = contentOverride === undefined ? JSON.stringify(VALID) : contentOverride;
  const statValue = statOverride === undefined ? { uid: UID, mode: 0o100600 } : statOverride;
  return {
    path: '/home/me/.pagespace/env-policy.json',
    uid: UID,
    open: (): OpenedPolicyFile | null => {
      const stat = typeof statValue === 'function' ? statValue() : statValue;
      if (stat === null) return null;
      const text = readFile ? readFile() : content;
      if (text === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { uid: stat.uid, mode: stat.mode, content: text };
    },
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
    const loaded = loadMachinePolicy({ path: '/p', uid: UID, open: () => { throw new Error('EACCES'); } });
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

  it('given a read that throws after a good open, should return "unreadable"', () => {
    const loaded = loadMachinePolicy(deps({ readFile: () => { throw new Error('EIO'); } }));
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

describe('openPolicyFile — the production adapter reads owner, mode AND content through ONE descriptor (CWE-367)', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ps-policy-')));
  const me = userInfo().uid;

  it('a fresh owner-only file: uid/mode from fstat, content from the same fd', () => {
    const path = join(dir, 'ok.json');
    writeFileSync(path, JSON.stringify(VALID), { mode: 0o600 });
    const opened = openPolicyFile(path);
    expect(opened).toMatchObject({ uid: me, mode: expect.any(Number), content: JSON.stringify(VALID) });
    expect((opened!.mode & 0o777)).toBe(0o600);
    expect(loadMachinePolicy({ path, uid: me, open: openPolicyFile }).policy).toEqual(VALID);
  });

  it('a group/world-writable file is refused from the fstat mode (no pathname stat anywhere)', () => {
    const path = join(dir, 'loose.json');
    writeFileSync(path, JSON.stringify(VALID));
    chmodSync(path, 0o666);
    expect(loadMachinePolicy({ path, uid: me, open: openPolicyFile }).reason).toBe('writable_by_others');
  });

  it('a symlink where the policy should be is never followed (O_NOFOLLOW) — treated as unreadable, deny-all', () => {
    const target = join(dir, 'target.json');
    writeFileSync(target, JSON.stringify(VALID), { mode: 0o600 });
    const link = join(dir, 'link.json');
    symlinkSync(target, link);
    expect(loadMachinePolicy({ path: link, uid: me, open: openPolicyFile }).reason).toBe('unreadable');
  });

  it('a missing file is "missing"', () => {
    expect(loadMachinePolicy({ path: join(dir, 'nope.json'), uid: me, open: openPolicyFile }).reason).toBe('missing');
  });

  it('cleanup', () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
