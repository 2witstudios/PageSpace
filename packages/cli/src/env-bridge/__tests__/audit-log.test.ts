import { describe, expect, it } from 'vitest';
import { createAuditLog, defaultAuditPath, formatAuditLine, type AuditEntry } from '../audit-log.js';

const NOW = Date.parse('2026-09-06T10:00:00.000Z');
const ENTRY: AuditEntry = {
  grantId: 'grant_1',
  principal: { userId: 'u1', sessionId: 's1', conversationId: 'c1' },
  op: 'exec',
  verdict: 'allow',
  argsHash: 'abc',
  exitCode: 0,
};

describe('audit-log (invariant 10: append-only JSONL, cross-referenceable with the server by grantId)', () => {
  it('should format one JSON line with ts first and the documented fields, no embedded newline', () => {
    const line = formatAuditLine(ENTRY, NOW);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({ ts: '2026-09-06T10:00:00.000Z', grantId: 'grant_1', principal: { userId: 'u1', sessionId: 's1', conversationId: 'c1' }, op: 'exec', verdict: 'allow', argsHash: 'abc', exitCode: 0 });
    expect(Object.keys(JSON.parse(line))[0]).toBe('ts');
  });

  describe('A5: the line names the paths, so the machine\'s own record can answer "what did it write"', () => {
    it('given an fs op with paths, should append them under `paths`, after every existing field and in request order', () => {
      const line = formatAuditLine({ ...ENTRY, op: 'fs_write', exitCode: null, paths: ['/home/u/proj/a', '/home/u/proj/.git/hooks/pre-commit'] }, NOW);
      expect(JSON.parse(line).paths).toEqual(['/home/u/proj/a', '/home/u/proj/.git/hooks/pre-commit']);
      // The JSONL consumer contract: every field the server's join uses keeps
      // its name AND its position, and `paths` comes last.
      expect(Object.keys(JSON.parse(line))).toEqual(['ts', 'grantId', 'principal', 'op', 'verdict', 'argsHash', 'exitCode', 'paths']);
    });

    it('given an exec (or any entry with no paths), should NOT gain a paths field — the line stays exactly as it was', () => {
      expect(Object.keys(JSON.parse(formatAuditLine(ENTRY, NOW)))).toEqual(['ts', 'grantId', 'principal', 'op', 'verdict', 'argsHash', 'exitCode']);
      expect(Object.keys(JSON.parse(formatAuditLine({ ...ENTRY, paths: null }, NOW)))).not.toContain('paths');
      expect(Object.keys(JSON.parse(formatAuditLine({ ...ENTRY, paths: [] }, NOW)))).not.toContain('paths');
    });
  });

  it('given a dropped frame with no grant, should still record a line with nulls rather than skipping it', () => {
    const line = formatAuditLine({ grantId: null, principal: null, op: null, verdict: 'dropped:malformed', argsHash: null, exitCode: null }, NOW);
    expect(JSON.parse(line)).toMatchObject({ grantId: null, principal: null, op: null, verdict: 'dropped:malformed', argsHash: null, exitCode: null });
  });

  it('should append every record through the injected sink, in order', async () => {
    const lines: string[] = [];
    const log = createAuditLog({ appendLine: async (line) => void lines.push(line), now: () => NOW });
    await log.record(ENTRY);
    await log.record({ ...ENTRY, grantId: 'grant_2', verdict: 'deny:no_policy', exitCode: null });
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).grantId).toBe('grant_2');
  });

  it('given the sink fails, should not throw (the daemon must never crash on audit I/O) and should report the failure once via onError', async () => {
    const errors: string[] = [];
    const log = createAuditLog({ appendLine: async () => { throw new Error('ENOSPC'); }, now: () => NOW, onError: (message) => void errors.push(message) });
    await expect(log.record(ENTRY)).resolves.toBeUndefined();
    await expect(log.record(ENTRY)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/ENOSPC/);
  });

  it('defaultAuditPath should be ~/.pagespace/env-audit.jsonl unless PAGESPACE_ENV_AUDIT_LOG is set', () => {
    expect(defaultAuditPath({}, '/home/me')).toBe('/home/me/.pagespace/env-audit.jsonl');
    expect(defaultAuditPath({ PAGESPACE_ENV_AUDIT_LOG: '/var/log/ps.jsonl' }, '/home/me')).toBe('/var/log/ps.jsonl');
  });
});
