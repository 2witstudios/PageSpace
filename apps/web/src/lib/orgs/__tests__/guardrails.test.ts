import { describe, it, expect } from 'vitest';
import {
  checkAIProviderAllowed,
  checkStorageLimit,
  checkAITokenLimit,
  checkExternalSharing,
  checkDomainAllowed,
  type OrgGuardrails,
} from '../guardrail-checks';

function makeGuardrails(overrides: Partial<OrgGuardrails> = {}): OrgGuardrails {
  return {
    allowedAIProviders: null,
    maxStorageBytes: null,
    maxAITokensPerDay: null,
    requireMFA: false,
    allowExternalSharing: true,
    allowedDomains: null,
    ...overrides,
  };
}

describe('checkAIProviderAllowed', () => {
  it('should allow any provider when allowedAIProviders is null', () => {
    const guardrails = makeGuardrails();
    const result = checkAIProviderAllowed(guardrails, 'openai');
    expect(result.allowed).toBe(true);
  });

  it('should allow any provider when allowedAIProviders is empty', () => {
    const guardrails = makeGuardrails({ allowedAIProviders: [] });
    const result = checkAIProviderAllowed(guardrails, 'openai');
    expect(result.allowed).toBe(true);
  });

  it('should allow a listed provider', () => {
    const guardrails = makeGuardrails({ allowedAIProviders: ['openai', 'anthropic'] });
    const result = checkAIProviderAllowed(guardrails, 'openai');
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('should deny an unlisted provider', () => {
    const guardrails = makeGuardrails({ allowedAIProviders: ['openai'] });
    const result = checkAIProviderAllowed(guardrails, 'anthropic');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('anthropic');
    expect(result.reason).toContain('not allowed');
  });
});

describe('checkStorageLimit', () => {
  it('should allow when no limit set', () => {
    const guardrails = makeGuardrails();
    const result = checkStorageLimit(guardrails, 1000, 500);
    expect(result.allowed).toBe(true);
  });

  it('should allow when within limit', () => {
    const guardrails = makeGuardrails({ maxStorageBytes: 1024 * 1024 });
    const result = checkStorageLimit(guardrails, 500000, 100000);
    expect(result.allowed).toBe(true);
  });

  it('should deny when exceeding limit', () => {
    const guardrails = makeGuardrails({ maxStorageBytes: 1024 * 1024 });
    const result = checkStorageLimit(guardrails, 900000, 200000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('storage limit exceeded');
  });

  it('should allow exactly at limit', () => {
    const guardrails = makeGuardrails({ maxStorageBytes: 1000 });
    const result = checkStorageLimit(guardrails, 500, 500);
    expect(result.allowed).toBe(true);
  });
});

describe('checkAITokenLimit', () => {
  it('should allow when no limit set', () => {
    const guardrails = makeGuardrails();
    const result = checkAITokenLimit(guardrails, 9999);
    expect(result.allowed).toBe(true);
  });

  it('should allow when under limit', () => {
    const guardrails = makeGuardrails({ maxAITokensPerDay: 1000 });
    const result = checkAITokenLimit(guardrails, 999);
    expect(result.allowed).toBe(true);
  });

  it('should deny when at or over limit', () => {
    const guardrails = makeGuardrails({ maxAITokensPerDay: 1000 });
    const result = checkAITokenLimit(guardrails, 1000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('AI token limit reached');
  });
});

describe('checkExternalSharing', () => {
  it('should allow when enabled', () => {
    const guardrails = makeGuardrails({ allowExternalSharing: true });
    const result = checkExternalSharing(guardrails);
    expect(result.allowed).toBe(true);
  });

  it('should deny when disabled', () => {
    const guardrails = makeGuardrails({ allowExternalSharing: false });
    const result = checkExternalSharing(guardrails);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('External sharing is disabled');
  });
});

describe('checkDomainAllowed', () => {
  it('should allow any domain when allowedDomains is null', () => {
    const guardrails = makeGuardrails();
    const result = checkDomainAllowed(guardrails, 'user@example.com');
    expect(result.allowed).toBe(true);
  });

  it('should allow any domain when allowedDomains is empty', () => {
    const guardrails = makeGuardrails({ allowedDomains: [] });
    const result = checkDomainAllowed(guardrails, 'user@example.com');
    expect(result.allowed).toBe(true);
  });

  it('should allow an email from an allowed domain', () => {
    const guardrails = makeGuardrails({ allowedDomains: ['acme.com'] });
    const result = checkDomainAllowed(guardrails, 'user@acme.com');
    expect(result.allowed).toBe(true);
  });

  it('should deny an email from a non-allowed domain', () => {
    const guardrails = makeGuardrails({ allowedDomains: ['acme.com'] });
    const result = checkDomainAllowed(guardrails, 'user@evil.com');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('evil.com');
    expect(result.reason).toContain('not allowed');
  });

  it('should be case-insensitive for domain matching', () => {
    const guardrails = makeGuardrails({ allowedDomains: ['Acme.COM'] });
    const result = checkDomainAllowed(guardrails, 'user@acme.com');
    expect(result.allowed).toBe(true);
  });

  it('should deny invalid email without domain', () => {
    const guardrails = makeGuardrails({ allowedDomains: ['acme.com'] });
    const result = checkDomainAllowed(guardrails, 'not-an-email');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Invalid email');
  });
});
