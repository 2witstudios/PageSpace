/**
 * ADR 0005 Decision 2 — the agent synthetic address and the reserved-domain
 * predicate every inbound auth path (five sites, Phase 1) and the outbound
 * email choke point key on. Pure: no env, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AGENT_EMAIL_DOMAIN,
  agentSyntheticEmail,
  isAgentReservedEmail,
  notAgentReservedEmail,
} from '../reserved-email';

describe('AGENT_EMAIL_DOMAIN', () => {
  it('is the RFC 2606 reserved agents subdomain', () => {
    expect(AGENT_EMAIL_DOMAIN).toBe('agents.pagespace.invalid');
  });
});

describe('agentSyntheticEmail', () => {
  it('is agent-<userId>@agents.pagespace.invalid', () => {
    expect(agentSyntheticEmail('clh0000000000000000000000')).toBe(
      'agent-clh0000000000000000000000@agents.pagespace.invalid',
    );
  });

  it('is unique per user id', () => {
    expect(agentSyntheticEmail('a')).not.toBe(agentSyntheticEmail('b'));
  });

  it('always satisfies the reserved predicate', () => {
    for (const id of ['a', 'user-1', 'clh0000000000000000000000']) {
      expect(isAgentReservedEmail(agentSyntheticEmail(id))).toBe(true);
    }
  });
});

describe('isAgentReservedEmail', () => {
  it('matches the reserved suffix exactly', () => {
    expect(isAgentReservedEmail('agent-x@agents.pagespace.invalid')).toBe(true);
  });

  it('matches case-insensitively and after trimming (normalizeEmail semantics)', () => {
    expect(isAgentReservedEmail('  Agent-X@AGENTS.PageSpace.INVALID  ')).toBe(true);
  });

  it('does NOT match the system users’ pagespace.invalid address', () => {
    expect(isAgentReservedEmail('system@pagespace.invalid')).toBe(false);
  });

  it('does NOT match pagespace.local', () => {
    expect(isAgentReservedEmail('someone@pagespace.local')).toBe(false);
  });

  it('does NOT match a domain that merely contains the reserved one as a prefix or infix', () => {
    expect(isAgentReservedEmail('x@agents.pagespace.invalid.evil.com')).toBe(false);
    expect(isAgentReservedEmail('x@evilagents.pagespace.invalid')).toBe(false);
    expect(isAgentReservedEmail('x@agents.pagespace.invalidx')).toBe(false);
  });

  it('does NOT match the bare domain with no local part or an @-less string', () => {
    expect(isAgentReservedEmail('@agents.pagespace.invalid')).toBe(false);
    expect(isAgentReservedEmail('agents.pagespace.invalid')).toBe(false);
  });

  it('does NOT match an address with more than one @', () => {
    expect(isAgentReservedEmail('a@b@agents.pagespace.invalid')).toBe(false);
  });

  it('is false for the empty string', () => {
    expect(isAgentReservedEmail('')).toBe(false);
  });
});

describe('notAgentReservedEmail (zod refinement)', () => {
  const schema = z.string().email().refine(notAgentReservedEmail, { message: 'Invalid email address' });

  it('accepts an ordinary address', () => {
    expect(schema.safeParse('person@example.com').success).toBe(true);
  });

  it('refuses a reserved address with the SAME message as a malformed one — no distinct oracle', () => {
    const reserved = schema.safeParse('agent-x@agents.pagespace.invalid');
    const malformed = schema.safeParse('not-an-email');
    expect(reserved.success).toBe(false);
    expect(malformed.success).toBe(false);
    const reservedMessage = reserved.success ? '' : reserved.error.issues[0]?.message;
    const malformedMessage = malformed.success ? '' : malformed.error.issues[0]?.message;
    expect(reservedMessage).toBe('Invalid email address');
    expect(malformedMessage).toBe('Invalid email address');
  });

  it('refuses the reserved address in any case', () => {
    expect(schema.safeParse('AGENT-X@AGENTS.PAGESPACE.INVALID').success).toBe(false);
  });
});

describe('isAgentReservedEmail — subdomains of the reserved domain', () => {
  it('treats a subdomain of the reserved domain as reserved (the whole subtree is ours)', () => {
    expect(isAgentReservedEmail('x@sub.agents.pagespace.invalid')).toBe(true);
  });
});
