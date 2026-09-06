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
