import { describe, it, expect } from 'vitest';
import {
  buildAuditRecord,
  buildActivityLogInput,
  buildSecurityAuditEvent,
  writeCodeExecutionAudit,
  type CodeExecutionAuditInput,
  type WriteAuditDeps,
} from '../audit';

const baseInput: CodeExecutionAuditInput = {
  userId: 'u1',
  actorEmail: 'dev@example.com',
  actorDisplayName: 'Dev',
  driveId: 'd1',
  conversationId: 'c1',
  profile: 'default',
  code: 'console.log("hello")',
  exitCode: 0,
  durationMs: 1234,
  costUsd: 0.0021,
  timestamp: new Date('2026-06-01T00:00:00.000Z'),
};

describe('buildAuditRecord', () => {
  it('should capture the full immutable shape: actor, code, profile, exit, duration, cost, timestamp', () => {
    const record = buildAuditRecord(baseInput);
    expect(record).toMatchObject({
      userId: 'u1',
      actorEmail: 'dev@example.com',
      profile: 'default',
      exitCode: 0,
      durationMs: 1234,
      costUsd: 0.0021,
      timestampIso: '2026-06-01T00:00:00.000Z',
    });
    expect(typeof record.code).toBe('string');
  });

  it('should default cost to zero and origin to user when omitted', () => {
    const { costUsd: _cost, requestOrigin: _origin, ...rest } = baseInput;
    const record = buildAuditRecord(rest);
    expect(record.costUsd).toBe(0);
    expect(record.requestOrigin).toBe('user');
  });

  it('should redact secret assignments in the captured code', () => {
    const record = buildAuditRecord({
      ...baseInput,
      code: 'const API_KEY = "fakesecretvalue0123456789abcdefghij"\nrun()',
    });
    expect(record.code).not.toContain('fakesecretvalue0123456789abcdefghij');
    expect(record.code).toContain('run()');
  });

  it('should redact bearer tokens and high-entropy standalone tokens', () => {
    const record = buildAuditRecord({
      ...baseInput,
      code: 'fetch(u, { headers: { Authorization: "Bearer abcDEF123456ghiJKL789mnoPQR0" } })',
    });
    expect(record.code).not.toContain('abcDEF123456ghiJKL789mnoPQR0');
  });

  it('should truncate over-long code and flag that it was truncated', () => {
    const record = buildAuditRecord({ ...baseInput, code: 'a();\n'.repeat(2000) });
    expect(record.codeTruncated).toBe(true);
    expect(record.code.length).toBeLessThan(10_000);
  });

  it('should not flag short code as truncated', () => {
    expect(buildAuditRecord(baseInput).codeTruncated).toBe(false);
  });
});

describe('buildActivityLogInput', () => {
  it('should map to the code_execution activity operation', () => {
    const input = buildActivityLogInput(buildAuditRecord(baseInput));
    expect(input.operation).toBe('code_execution');
    expect(input.userId).toBe('u1');
    expect(input.actorEmail).toBe('dev@example.com');
  });

  it('should scope the activity to the conversation when present', () => {
    const input = buildActivityLogInput(buildAuditRecord(baseInput));
    expect(input.resourceType).toBe('conversation');
    expect(input.resourceId).toBe('c1');
  });

  it('should carry the redacted code, never the raw secret', () => {
    const record = buildAuditRecord({
      ...baseInput,
      code: 'token="faketokenvalue0123456789abcdefghijklmn"',
    });
    const input = buildActivityLogInput(record);
    expect(JSON.stringify(input)).not.toContain('faketokenvalue0123456789abcdefghijklmn');
  });
});

describe('buildSecurityAuditEvent', () => {
  it('should produce no security event for a clean run', () => {
    expect(buildSecurityAuditEvent(buildAuditRecord(baseInput))).toBeNull();
  });

  it('should emit an anomaly event flagged with the anomaly kind', () => {
    const record = buildAuditRecord({ ...baseInput, anomaly: 'timeout', exitCode: null });
    const event = buildSecurityAuditEvent(record);
    expect(event?.anomalyFlags).toContain('timeout');
    expect(event?.userId).toBe('u1');
    expect((event?.riskScore ?? 0)).toBeGreaterThan(0);
  });
});

describe('writeCodeExecutionAudit', () => {
  function makeDeps() {
    const activityCalls: unknown[] = [];
    const securityCalls: unknown[] = [];
    const deps: WriteAuditDeps = {
      logActivity: async (input) => {
        activityCalls.push(input);
      },
      logSecurityEvent: async (event) => {
        securityCalls.push(event);
      },
    };
    return { deps, activityCalls, securityCalls };
  }

  it('should always write the activity audit record', async () => {
    const { deps, activityCalls } = makeDeps();
    await writeCodeExecutionAudit({ input: baseInput, deps });
    expect(activityCalls).toHaveLength(1);
  });

  it('should route an anomalous run to the security audit log', async () => {
    const { deps, securityCalls } = makeDeps();
    await writeCodeExecutionAudit({
      input: { ...baseInput, anomaly: 'blocked_command' },
      deps,
    });
    expect(securityCalls).toHaveLength(1);
  });

  it('should not write a security event for a clean run', async () => {
    const { deps, securityCalls } = makeDeps();
    await writeCodeExecutionAudit({ input: baseInput, deps });
    expect(securityCalls).toHaveLength(0);
  });

  it('should never throw even when an audit sink fails', async () => {
    const deps: WriteAuditDeps = {
      logActivity: async () => {
        throw new Error('activity sink down');
      },
      logSecurityEvent: async () => {
        throw new Error('security sink down');
      },
    };
    await expect(
      writeCodeExecutionAudit({ input: { ...baseInput, anomaly: 'oom' }, deps }),
    ).resolves.toBeUndefined();
  });
});
