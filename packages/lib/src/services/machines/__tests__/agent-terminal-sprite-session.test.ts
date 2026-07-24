import { describe, it, expect } from 'vitest';
import { deriveAgentTerminalSessionSpriteKey } from '../agent-terminal-sprite-session';

const SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
const base = { tenantId: 'tenant-1', machineId: 'machine-1', terminalId: 'terminal-1', secret: SECRET };

describe('deriveAgentTerminalSessionSpriteKey', () => {
  it('given an empty secret, should throw (never derive an unkeyed name)', () => {
    expect(() => deriveAgentTerminalSessionSpriteKey({ ...base, secret: '' })).toThrow(/non-empty secret/);
  });

  it('given the same inputs, should be deterministic', () => {
    expect(deriveAgentTerminalSessionSpriteKey(base)).toBe(deriveAgentTerminalSessionSpriteKey(base));
  });

  it('should carry the pgs-agt- Sprite-name prefix', () => {
    expect(deriveAgentTerminalSessionSpriteKey(base)).toMatch(/^pgs-agt-[0-9a-f]{64}$/);
  });

  it('given different terminal ids, should resolve to DIFFERENT Sprite names (per-session isolation)', () => {
    const a = deriveAgentTerminalSessionSpriteKey({ ...base, terminalId: 'terminal-1' });
    const b = deriveAgentTerminalSessionSpriteKey({ ...base, terminalId: 'terminal-2' });
    expect(a).not.toBe(b);
  });

  it('given different machines, should resolve to different names', () => {
    const a = deriveAgentTerminalSessionSpriteKey({ ...base, machineId: 'machine-1' });
    const b = deriveAgentTerminalSessionSpriteKey({ ...base, machineId: 'machine-2' });
    expect(a).not.toBe(b);
  });

  it('given different tenants, should resolve to different names', () => {
    const a = deriveAgentTerminalSessionSpriteKey({ ...base, tenantId: 'tenant-1' });
    const b = deriveAgentTerminalSessionSpriteKey({ ...base, tenantId: 'tenant-2' });
    expect(a).not.toBe(b);
  });

  it('should be namespaced distinctly from the branch Sprite key (no cross-namespace collision)', () => {
    // A branch key uses the `pgs-brn-` prefix; a session Sprite key uses `pgs-agt-`.
    expect(deriveAgentTerminalSessionSpriteKey(base).startsWith('pgs-agt-')).toBe(true);
  });
});
