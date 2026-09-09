/**
 * `summarizeGrantRequest` — the one line a person reads on the activity
 * panel (GA wave 3, leaf 1). Pure; pinned per op, plus the bound and the
 * quoting that keeps a multi-word argument readable as one word.
 */
import { describe, it, expect } from 'vitest';
import { summarizeGrantRequest, GRANT_AUDIT_SUMMARY_MAX_CHARS } from '../grant-audit-store';
import { GRANT_OPS } from '../../../env-bridge/grant';
import { DRIVE_ENV_GRANT_AUDIT_OPS } from '@pagespace/db/schema/drive-env-grant-audit';

describe('the table\'s op CHECK is the wire vocabulary', () => {
  it('DRIVE_ENV_GRANT_AUDIT_OPS equals GRANT_OPS, so the CHECK and the grant cannot drift', () => {
    expect([...DRIVE_ENV_GRANT_AUDIT_OPS]).toEqual([...GRANT_OPS]);
  });
});

describe('summarizeGrantRequest', () => {
  it('exec: the argv with a cwd, multi-word arguments quoted for the eye', () => {
    expect(summarizeGrantRequest({ op: 'exec', args: { cmd: 'sh', args: ['-c', 'git status'], cwd: '/home/o/proj', env: {}, timeoutMs: null, maxBytes: null } })).toBe("exec: sh -c 'git status' in /home/o/proj");
  });

  it('exec without a cwd omits the location', () => {
    expect(summarizeGrantRequest({ op: 'exec', args: { cmd: 'ls', args: [], cwd: null, env: {}, timeoutMs: null, maxBytes: null } })).toBe('exec: ls');
  });

  it('fs_read: the paths; fs_write: the paths, never the content', () => {
    expect(summarizeGrantRequest({ op: 'fs_read', args: { paths: ['/a', '/b'] } })).toBe('fs_read: /a, /b');
    expect(summarizeGrantRequest({ op: 'fs_write', args: { files: [{ path: '/a', contentB64: 'c2VjcmV0', mode: null }] } })).toBe('fs_write: /a');
  });

  it('pty_open: the command when there is one, the bare op otherwise', () => {
    expect(summarizeGrantRequest({ op: 'pty_open', args: { cols: 80, rows: 24, cwd: null, command: 'bash', args: ['-l'] } })).toBe('pty_open: bash -l');
    expect(summarizeGrantRequest({ op: 'pty_open', args: { cols: 80, rows: 24, cwd: null, command: null, args: [] } })).toBe('pty_open');
  });

  it('is bounded: a 10k-character command line is clipped with an ellipsis', () => {
    const line = summarizeGrantRequest({ op: 'exec', args: { cmd: 'x'.repeat(10_000), args: [], cwd: null, env: {}, timeoutMs: null, maxBytes: null } });
    expect(line).toHaveLength(GRANT_AUDIT_SUMMARY_MAX_CHARS);
    expect(line.endsWith('…')).toBe(true);
  });
});
