import { describe, it, expect } from 'vitest';
import {
  parseShellActivityRequest,
  validateShellActivityPayload,
  formatShellActivityLine,
  handleShellActivityRequest,
  type ShellActivityPayload,
  type ShellActivityDeps,
} from '../shell-activity';
import type { TerminalSession } from '../terminal-session-map';

function makePayload(over: Partial<ShellActivityPayload> = {}): ShellActivityPayload {
  return {
    sessionId: 'conv-1',
    command: 'echo hi',
    output: 'hi',
    exitCode: 0,
    agentLabel: 'Agent Bob',
    ...over,
  };
}

function makeSession(): { session: TerminalSession; emitted: string[]; emittedB: string[] } {
  const emitted: string[] = [];
  const emittedB: string[] = [];
  const session = {
    command: {} as TerminalSession['command'],
    sandboxId: 'sbx-1',
    sessionKey: 'key-1',
    lastViewerUserId: 'user1',
    releaseSlot: () => {},
    viewers: new Map([
      ['sockA conn-a', { userId: 'user1', emitOutput: (data: string) => emitted.push(data), emitClosed: () => {}, emitError: () => {} }],
      ['sockB conn-b', { userId: 'user2', emitOutput: (data: string) => emittedB.push(data), emitClosed: () => {}, emitError: () => {} }],
    ]),
    scrollback: [],
    scrollbackBytes: 0,
  } as TerminalSession;
  return { session, emitted, emittedB };
}

describe('parseShellActivityRequest', () => {
  it('given valid JSON, should parse it', () => {
    const result = parseShellActivityRequest(JSON.stringify(makePayload()));
    expect(result.success).toBe(true);
    expect(result.payload?.command).toBe('echo hi');
  });

  it('given invalid JSON, should fail', () => {
    const result = parseShellActivityRequest('not json');
    expect(result).toEqual({ success: false, error: 'Invalid JSON' });
  });
});

describe('validateShellActivityPayload', () => {
  it('given a well-formed payload, should be valid', () => {
    expect(validateShellActivityPayload(makePayload())).toEqual({ valid: true });
  });

  it('given a missing sessionId, should be invalid', () => {
    const result = validateShellActivityPayload(makePayload({ sessionId: '' }));
    expect(result.valid).toBe(false);
  });

  it('given a missing command, should be invalid', () => {
    const result = validateShellActivityPayload(makePayload({ command: '' }));
    expect(result.valid).toBe(false);
  });

  it('given a non-string output, should be invalid', () => {
    const result = validateShellActivityPayload(
      makePayload({ output: 123 as unknown as string }),
    );
    expect(result.valid).toBe(false);
  });

  it('given a non-numeric exitCode, should be invalid', () => {
    const result = validateShellActivityPayload(
      makePayload({ exitCode: 'zero' as unknown as number }),
    );
    expect(result.valid).toBe(false);
  });

  it('given a missing agentLabel, should be invalid', () => {
    const result = validateShellActivityPayload(makePayload({ agentLabel: '' }));
    expect(result.valid).toBe(false);
  });
});

describe('formatShellActivityLine', () => {
  it('should annotate the command, output, and exit code with CRLF line endings', () => {
    const text = formatShellActivityLine(makePayload());
    expect(text).toContain('Agent Bob ran:');
    expect(text).toContain('echo hi');
    expect(text).toContain('hi\r\n');
    expect(text).toContain('(exit 0)');
    expect(text.startsWith('\r\n')).toBe(true);
  });

  it('given multi-line output, should normalize to CRLF', () => {
    const text = formatShellActivityLine(makePayload({ output: 'line1\nline2' }));
    expect(text).toContain('line1\r\nline2\r\n');
  });

  it('given empty output, should omit the body line', () => {
    const text = formatShellActivityLine(makePayload({ output: '' }));
    expect(text).toContain('ran:');
    expect(text).toContain('(exit 0)');
  });

  it('given output over the feed cap, should truncate it', () => {
    const big = 'x'.repeat(10 * 1024);
    const text = formatShellActivityLine(makePayload({ output: big }));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(Buffer.byteLength(big, 'utf8'));
  });

  it('given an ESC byte embedded in the command, should strip it instead of forwarding a raw escape sequence', () => {
    // A model-chosen command could carry an ANSI/OSC escape sequence (e.g. via
    // indirect prompt injection) intended to spoof output in the viewer's xterm.js
    // feed. The header/footer's OWN color codes must survive; only the payload's
    // control bytes should be stripped.
    const malicious = 'echo hi\x1b[31mFAKE ERROR\x1b[0m';
    const text = formatShellActivityLine(makePayload({ command: malicious }));
    expect(text).toContain('echo hi[31mFAKE ERROR[0m');
    expect(text).not.toContain('\x1b[31m');
  });

  it("given an ESC byte embedded in the output, should strip it (only the header/footer's own codes remain)", () => {
    const text = formatShellActivityLine(makePayload({ output: 'safe\x1b]0;evil-title\x07text' }));
    expect(text).toContain('safe]0;evil-titletext');
    expect(text).not.toContain('\x1b]0;evil-title\x07');
  });

  it("given an ESC byte embedded in agentLabel, should strip it (only the header/footer's own codes remain)", () => {
    const text = formatShellActivityLine(makePayload({ agentLabel: 'Bob\x1b[2J' }));
    expect(text).toContain('Bob[2J ran:');
    expect(text).not.toContain('\x1b[2J');
  });

  it("given the header/footer's own ANSI color codes, should still preserve them (only the payload is sanitized)", () => {
    const text = formatShellActivityLine(makePayload());
    expect(text).toContain('\x1b[36m');
    expect(text).toContain('\x1b[90m');
  });

  it('given real newlines/tabs in output, should preserve them (only control/escape bytes are stripped)', () => {
    const text = formatShellActivityLine(makePayload({ output: 'line1\nline2\ttabbed' }));
    expect(text).toContain('line1\r\nline2\ttabbed');
  });
});

describe('handleShellActivityRequest', () => {
  function makeDeps(over: Partial<ShellActivityDeps> = {}): ShellActivityDeps {
    return {
      sessionMap: { getByKey: () => undefined },
      resolveShellKeys: async (sessionId) => [`k:${sessionId}:shl-1`],
      ...over,
    };
  }

  it('given invalid JSON, should return 400', async () => {
    const result = await handleShellActivityRequest(makeDeps(), 'not json');
    expect(result.status).toBe(400);
    expect(result.body.success).toBe(false);
  });

  it('given an invalid payload, should return 400', async () => {
    const result = await handleShellActivityRequest(makeDeps(), JSON.stringify({ command: 'ls' }));
    expect(result.status).toBe(400);
    expect(result.body.success).toBe(false);
  });

  it('given a session with no shells at all, should return 200 with delivered: false', async () => {
    const deps = makeDeps({ resolveShellKeys: async () => [] });
    const result = await handleShellActivityRequest(deps, JSON.stringify(makePayload()));
    expect(result).toEqual({ status: 200, body: { success: true, delivered: false } });
  });

  it('given no live PTY for any of the resolved shells, should return 200 with delivered: false', async () => {
    const result = await handleShellActivityRequest(makeDeps(), JSON.stringify(makePayload()));
    expect(result).toEqual({ status: 200, body: { success: true, delivered: false } });
  });

  it("given a live shell, should inject the formatted line into its scrollback and EVERY attached viewer's feed (#2093)", async () => {
    const { session, emitted, emittedB } = makeSession();
    const deps = makeDeps({
      sessionMap: { getByKey: (key) => (key === 'k:conv-1:shl-1' ? session : undefined) },
    });

    const result = await handleShellActivityRequest(deps, JSON.stringify(makePayload()));

    expect(result).toEqual({ status: 200, body: { success: true, delivered: true } });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toContain('Agent Bob ran:');
    expect(emittedB).toEqual(emitted);
    expect(session.scrollback).toEqual(emitted);
  });

  it("given SEVERAL live shells in the session, should inject into every one of them — they all share the sandbox the agent acted on", async () => {
    const a = makeSession();
    const b = makeSession();
    const deps = makeDeps({
      resolveShellKeys: async () => ['k:conv-1:shl-1', 'k:conv-1:shl-2'],
      sessionMap: {
        getByKey: (key) =>
          key === 'k:conv-1:shl-1' ? a.session : key === 'k:conv-1:shl-2' ? b.session : undefined,
      },
    });

    const result = await handleShellActivityRequest(deps, JSON.stringify(makePayload()));

    expect(result.body).toEqual({ success: true, delivered: true });
    expect(a.emitted).toHaveLength(1);
    expect(b.emitted).toHaveLength(1);
  });

  it('given a live shell on a DIFFERENT key, should not deliver', async () => {
    const { session, emitted } = makeSession();
    const deps = makeDeps({
      sessionMap: { getByKey: (key) => (key === 'some-other-key' ? session : undefined) },
    });

    const result = await handleShellActivityRequest(deps, JSON.stringify(makePayload()));

    expect(result.body).toEqual({ success: true, delivered: false });
    expect(emitted).toHaveLength(0);
  });
});
