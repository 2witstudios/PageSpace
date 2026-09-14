import { describe, it, expect } from 'vitest';
import { appliesAgentTriggerHold, refuseOAuthAgentTrigger } from '../oauth-agent-trigger-hold';
import { mcpDriveKey, oauthDriveGrant } from './oauth-principal-fixture';
import type { AuthResult } from '../index';

const session: AuthResult = { tokenType: 'session', sessionId: 's', userId: 'u', role: 'user', tokenVersion: 0, adminRoleVersion: 0 };

describe('refuseOAuthAgentTrigger (point-guard hold pending Phase 2b / [D-15])', () => {
  it('refuses an OAuth principal whose input would create or fire an agent trigger, with a constant 403', async () => {
    for (const intent of [{ writesTrigger: true, firesTrigger: false }, { writesTrigger: false, firesTrigger: true }]) {
      const res = refuseOAuthAgentTrigger(oauthDriveGrant('drivex', 'admin'), intent);
      expect(res?.status).toBe(403);
      expect(await res!.json()).toEqual({ error: 'Agent triggers are not available to OAuth applications' });
    }
  });

  it('lets an OAuth principal through when the input carries no trigger', () => {
    expect(refuseOAuthAgentTrigger(oauthDriveGrant('drivex', 'admin'), { writesTrigger: false, firesTrigger: false })).toBeNull();
  });

  it('applies to OAuth principals only', () => {
    expect(appliesAgentTriggerHold(oauthDriveGrant('drivex'))).toBe(true);
    expect(appliesAgentTriggerHold(mcpDriveKey('drivex'))).toBe(false);
    expect(appliesAgentTriggerHold(session)).toBe(false);
  });

  it('never changes what an mcp_ key or a session may do', () => {
    for (const principal of [mcpDriveKey('drivex'), session]) {
      expect(refuseOAuthAgentTrigger(principal, { writesTrigger: true, firesTrigger: true })).toBeNull();
    }
  });
});
