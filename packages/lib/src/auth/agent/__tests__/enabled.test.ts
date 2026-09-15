/**
 * ADR 0005 Decision 11 — cloud + tenant enabled; onprem only when the operator
 * sets AGENT_SIGNUP_ENABLED to exactly 'true'. Pure function of injected values.
 */
import { describe, it, expect } from 'vitest';
import { isAgentSignupEnabled } from '../enabled';

describe('isAgentSignupEnabled', () => {
  it('is true for cloud regardless of the flag', () => {
    expect(isAgentSignupEnabled({ deploymentMode: 'cloud', envFlag: undefined })).toBe(true);
    expect(isAgentSignupEnabled({ deploymentMode: 'cloud', envFlag: 'false' })).toBe(true);
  });

  it('is true for tenant regardless of the flag (tenant is a cloud topology, not onprem)', () => {
    expect(isAgentSignupEnabled({ deploymentMode: 'tenant', envFlag: undefined })).toBe(true);
    expect(isAgentSignupEnabled({ deploymentMode: 'tenant', envFlag: 'false' })).toBe(true);
  });

  it('is true for onprem only when the flag is exactly "true"', () => {
    expect(isAgentSignupEnabled({ deploymentMode: 'onprem', envFlag: 'true' })).toBe(true);
  });

  it('is false for onprem when the flag is unset, empty, or any other spelling', () => {
    expect(isAgentSignupEnabled({ deploymentMode: 'onprem', envFlag: undefined })).toBe(false);
    expect(isAgentSignupEnabled({ deploymentMode: 'onprem', envFlag: '' })).toBe(false);
    expect(isAgentSignupEnabled({ deploymentMode: 'onprem', envFlag: 'TRUE' })).toBe(false);
    expect(isAgentSignupEnabled({ deploymentMode: 'onprem', envFlag: '1' })).toBe(false);
    expect(isAgentSignupEnabled({ deploymentMode: 'onprem', envFlag: 'yes' })).toBe(false);
    expect(isAgentSignupEnabled({ deploymentMode: 'onprem', envFlag: ' true ' })).toBe(false);
  });
});
