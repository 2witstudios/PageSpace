import { describe, it, expect } from 'vitest';
import {
  parseTerminalActivityRequest,
  validateTerminalActivityPayload,
  formatTerminalActivityLine,
  handleTerminalActivityRequest,
  type TerminalActivityPayload,
  type TerminalActivityDeps,
} from '../terminal-activity';
import type { TerminalSession } from '../terminal-session-map';

function makePayload(over: Partial<TerminalActivityPayload> = {}): TerminalActivityPayload {
  return {
    tenantId: 't1',
    driveId: 'd1',
    pageId: 'terminal-page-1',
    command: 'echo hi',
    output: 'hi',
    exitCode: 0,
    agentLabel: 'Agent Bob',
    ...over,
  };
}

function makeSession(): { session: TerminalSession; emitted: string[] } {
  const emitted: string[] = [];
  const session = {
    command: {} as TerminalSession['command'],
    sandboxId: 'sbx-1',
    sessionKey: 'key-1',
    releaseSlot: () => {},
    outputFn: (data: string) => emitted.push(data),
    closedFn: () => {},
    scrollback: [],
    scrollbackBytes: 0,
  } as TerminalSession;
  return { session, emitted };
}

describe('parseTerminalActivityRequest', () => {
  it('given valid JSON, should parse it', () => {
    const result = parseTerminalActivityRequest(JSON.stringify(makePayload()));
    expect(result.success).toBe(true);
    expect(result.payload?.command).toBe('echo hi');
  });

  it('given invalid JSON, should fail', () => {
    const result = parseTerminalActivityRequest('not json');
    expect(result).toEqual({ success: false, error: 'Invalid JSON' });
  });
});

describe('validateTerminalActivityPayload', () => {
  it('given a well-formed payload, should be valid', () => {
    expect(validateTerminalActivityPayload(makePayload())).toEqual({ valid: true });
  });

  it('given a missing tenantId, should be invalid', () => {
    const result = validateTerminalActivityPayload(makePayload({ tenantId: '' }));
    expect(result.valid).toBe(false);
  });

  it('given a missing pageId, should be invalid', () => {
    const result = validateTerminalActivityPayload(makePayload({ pageId: '' }));
    expect(result.valid).toBe(false);
  });

  it('given a missing command, should be invalid', () => {
    const result = validateTerminalActivityPayload(makePayload({ command: '' }));
    expect(result.valid).toBe(false);
  });

  it('given a non-string output, should be invalid', () => {
    const result = validateTerminalActivityPayload(
      makePayload({ output: 123 as unknown as string }),
    );
    expect(result.valid).toBe(false);
  });

  it('given a non-numeric exitCode, should be invalid', () => {
    const result = validateTerminalActivityPayload(
      makePayload({ exitCode: 'zero' as unknown as number }),
    );
    expect(result.valid).toBe(false);
  });

  it('given a missing agentLabel, should be invalid', () => {
    const result = validateTerminalActivityPayload(makePayload({ agentLabel: '' }));
    expect(result.valid).toBe(false);
  });

  it('given no driveId, should still be valid (global-assistant "own" machine)', () => {
    const result = validateTerminalActivityPayload(makePayload({ driveId: undefined }));
    expect(result).toEqual({ valid: true });
  });
});

describe('formatTerminalActivityLine', () => {
  it('should annotate the command, output, and exit code with CRLF line endings', () => {
    const text = formatTerminalActivityLine(makePayload());
    expect(text).toContain('Agent Bob ran:');
    expect(text).toContain('echo hi');
    expect(text).toContain('hi\r\n');
    expect(text).toContain('(exit 0)');
    expect(text.startsWith('\r\n')).toBe(true);
  });

  it('given multi-line output, should normalize to CRLF', () => {
    const text = formatTerminalActivityLine(makePayload({ output: 'line1\nline2' }));
    expect(text).toContain('line1\r\nline2\r\n');
  });

  it('given empty output, should omit the body line', () => {
    const text = formatTerminalActivityLine(makePayload({ output: '' }));
    expect(text).toContain('ran:');
    expect(text).toContain('(exit 0)');
  });

  it('given output over the feed cap, should truncate it', () => {
    const big = 'x'.repeat(10 * 1024);
    const text = formatTerminalActivityLine(makePayload({ output: big }));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(Buffer.byteLength(big, 'utf8'));
  });
});

describe('handleTerminalActivityRequest', () => {
  function makeDeps(over: Partial<TerminalActivityDeps> = {}): TerminalActivityDeps {
    return {
      sessionMap: { getByKey: () => undefined },
      deriveSessionKey: ({ tenantId, driveId, pageId }) => `${tenantId}:${driveId}:${pageId}`,
      ...over,
    };
  }

  it('given invalid JSON, should return 400', () => {
    const result = handleTerminalActivityRequest(makeDeps(), 'not json');
    expect(result.status).toBe(400);
    expect(result.body.success).toBe(false);
  });

  it('given an invalid payload, should return 400', () => {
    const result = handleTerminalActivityRequest(makeDeps(), JSON.stringify({ tenantId: 't1' }));
    expect(result.status).toBe(400);
    expect(result.body.success).toBe(false);
  });

  it('given no driveId, should return 200 with delivered: false without deriving a session key', () => {
    let called = false;
    const deps = makeDeps({ deriveSessionKey: () => { called = true; return 'x'; } });
    const result = handleTerminalActivityRequest(deps, JSON.stringify(makePayload({ driveId: undefined })));
    expect(result).toEqual({ status: 200, body: { success: true, delivered: false } });
    expect(called).toBe(false);
  });

  it('given no live session for the derived key, should return 200 with delivered: false', () => {
    const result = handleTerminalActivityRequest(makeDeps(), JSON.stringify(makePayload()));
    expect(result).toEqual({ status: 200, body: { success: true, delivered: false } });
  });

  it('given a live session, should inject the formatted line into its scrollback and output feed', () => {
    const { session, emitted } = makeSession();
    const deps = makeDeps({
      sessionMap: { getByKey: (key) => (key === 't1:d1:terminal-page-1' ? session : undefined) },
    });

    const result = handleTerminalActivityRequest(deps, JSON.stringify(makePayload()));

    expect(result).toEqual({ status: 200, body: { success: true, delivered: true } });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('Agent Bob ran:');
    expect(session.scrollback).toEqual(emitted);
  });

  it('given a live session on a DIFFERENT key, should not deliver', () => {
    const { session, emitted } = makeSession();
    const deps = makeDeps({
      sessionMap: { getByKey: (key) => (key === 'some-other-key' ? session : undefined) },
    });

    const result = handleTerminalActivityRequest(deps, JSON.stringify(makePayload()));

    expect(result.body).toEqual({ success: true, delivered: false });
    expect(emitted).toHaveLength(0);
  });
});
