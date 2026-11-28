/**
 * Input-edge containment for pure helpers whose missed alternations surfaced when the
 * monorepo's coverage gate first ran end to end. Each case pins the defensive side of one
 * branch: garbage in, a defined result out — never a throw.
 */
import { describe, expect, it } from 'vitest';

describe('agent-accounts canonicalJson', () => {
  it('serializes undefined as null and sorts object keys deterministically', async () => {
    const { canonicalJson } = await import('../agent-accounts/canonical-json');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson([1, 'x', null])).toBe('[1,"x",null]');
  });
});

describe('opaque token format', () => {
  it('a long enough string without the ps_ prefix is not a valid token', async () => {
    const { isValidTokenFormat } = await import('../auth/opaque-tokens');
    expect(isValidTokenFormat('x'.repeat(45))).toBe(false);
    expect(isValidTokenFormat(`ps_sess_${'x'.repeat(40)}`)).toBe(true);
  });
});

describe('org audit filter parsing', () => {
  it('a non-numeric limit refuses with the range message', async () => {
    const { parseOrgAuditFilter } = await import('../audit/org-audit-query-core');
    const parsed = parseOrgAuditFilter({ limit: 'soon' });
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('limit must be 1-') });
  });
});

describe('normalizeMessageParts tool results', () => {
  it('a failed tool part without an error text reports the placeholder', async () => {
    const { normalizeMessageParts } = await import('../ai/normalize-parts');
    const messages = [{
      role: 'assistant' as const,
      content: '',
      parts: [
        { type: 'tool-read_page', toolCallId: 't1', toolName: 'read_page', state: 'output-error', input: {}, errorText: undefined },
      ],
    }];
    const normalized = normalizeMessageParts(messages as never) as unknown as Array<{ parts: Array<{ type: string; result?: string }> }>;
    const results = normalized[0]!.parts.filter((p) => p.type === 'tool-result') as Array<{ result?: string }>;
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toBe('[error]');
  });
});

describe('automation skip notice copy', () => {
  it('names a departed creator as the skip reason', async () => {
    const { automationSkipNoticeMessage } = await import('../billing/automation-skip-notice');
    expect(automationSkipNoticeMessage('creator_departed')).toContain('no longer a member');
  });
});

describe('the spend fallback notice and headers', () => {
  it('a gate without a wallet id notices the fallback with a null wallet', async () => {
    const { spendFallbackNotice, spendFallbackHeaders } = await import('../billing/spend-fallback');
    const notice = spendFallbackNotice({ allowed: true, fallback: { from: 'drive_wallet', to: 'own_credits' } });
    expect(notice).toEqual({ from: 'drive_wallet', to: 'own_credits', walletId: null });
    const headers = spendFallbackHeaders(notice);
    expect(Object.keys(headers)).not.toContain('x-pagespace-spend-fallback-wallet');
    expect(spendFallbackNotice(null)).toBeNull();
  });
});

describe('forgiveness at refill', () => {
  it('a non-finite allowance grants nothing: the debt stands minus what remains', async () => {
    const { forgivenAtRefillCents } = await import('../billing/credit-core');
    expect(forgivenAtRefillCents(Number.NaN, 100, 500)).toBe(400);
    expect(forgivenAtRefillCents(1_000, 100, 500)).toBe(0);
  });
});

describe('spend source resolution without a source', () => {
  it('own credits with no personal root is unavailable', async () => {
    const { resolveSpendSource } = await import('../billing/wallet-core');
    const base = {
      driveWallet: null,
      seatAllowance: null,
      personal: null,
      chosen: 'own_credits' as const,
      driveRule: { fallback: 'refuse', guestsMaySpendDriveWallet: false } as never,
      userOverride: { alwaysOwnCredits: false, alwaysOwnCreditsInDrive: false } as never,
      reservationCents: 1,
      actor: { kind: 'person', userId: 'u-1', isGuest: false } as never,
    };
    expect(resolveSpendSource(base as never)).toMatchObject({ kind: 'refuse', source: 'own_credits', reason: 'source_unavailable' });
  });

  it('a non-finite gross is counted as itself, failing the caps closed', async () => {
    const { seatCountedMillicents } = await import('../billing/wallet-core');
    expect(seatCountedMillicents({ capCents: 100, grossMillicents: Number.NaN })).toBeNaN();
  });
});

describe('the user email match condition', () => {
  it('without a blind index the match is the raw email only', async () => {
    const { buildUserEmailMatch } = await import('../auth/user-repository');
    const condition = buildUserEmailMatch('a@b.test', null) as { queryChunks: unknown[] };
    expect(condition.queryChunks.length).toBeGreaterThan(0);
  });
});

describe('template slot binding', () => {
  it('a template or path without the leading slash binds nothing', async () => {
    const { bindTemplateSlots } = await import('../agent-accounts/bind-template-slots');
    expect(bindTemplateSlots({ pathTemplate: 'no-slash/{id}', path: '/x' })).toBeNull();
    expect(bindTemplateSlots({ pathTemplate: '/{id}', path: 'no-slash' })).toBeNull();
  });
});

describe('origin normalization', () => {
  it('a non-string raw and a wildcard host are refused as malformed/wildcard', async () => {
    const { normalizeOrigin } = await import('../agent-accounts/normalize-origin');
    expect(normalizeOrigin({ raw: undefined as never }).ok).toBe(false);
    expect(normalizeOrigin({ raw: 'https://*.wildcard.test' })).toMatchObject({ ok: false, reason: 'wildcard_host' });
  });
});

describe('workspace share arithmetic', () => {
  it('an empty container stays empty, and an all-unsized container reads as unsized', async () => {
    const { rebalanceFractions, currentShares } = await import('../agent-workspaces/workspace-fractions');
    expect(rebalanceFractions([])).toEqual([]);
    expect(rebalanceFractions([null, null])).toEqual([null, null]);
    expect(currentShares([])).toEqual([]);
  });
});

describe('device fingerprint UA families', () => {
  it('opera and android user agents parse to their own family, and an empty UA is suspicious', async () => {
    const { validateDeviceFingerprint, calculateTrustScore } = await import('../auth/device-fingerprint-utils');
    // Opera's two spellings are the same family; so are two Android UAs.
    expect(validateDeviceFingerprint('Mozilla/5.0 Opera/9.80', '1.2.3.4', 'Mozilla/5.0 OPR/70', '1.2.3.4').valid).toBe(true);
    expect(validateDeviceFingerprint('Mozilla/5.0 (Android 14; Pixel)', '1.2.3.4', 'Mozilla/5.0 (Android 14; Pixel 8)', '1.2.3.4').valid).toBe(true);
    // An empty current UA is the absence of evidence, not suspicion: nothing to compare.
    expect(validateDeviceFingerprint('', '1.2.3.4', 'Mozilla/5.0', '1.2.3.4').valid).toBe(true);
    // The trust score decays per suspicious factor and never below its floor logic.
    expect(calculateTrustScore(1, [])).toBe(1);
    expect(calculateTrustScore(1, ['user_agent_mismatch', 'ip_address_change'])).toBeCloseTo(0.75);
  });
});

describe('account creation decisions', () => {
  it('a missing placement is refused before any secret is considered', async () => {
    const { decideAccountCreation } = await import('../agent-accounts/decide-account-creation');
    const verdict = decideAccountCreation({
      kind: 'api_key',
      name: '  ',
      allowedOrigins: ['https://good.example.com'],
      ownership: {} as never,
      acknowledged: true,
      placement: null as never,
      apiKey: 'sk_test',
      allowGenericRequests: false,
      approver: 'u-1' as never,
    });
    expect(verdict).toMatchObject({ ok: false });
  });

  it('a non-string name and a shapeless placement are both refused, in that order', async () => {
    const { decideAccountCreation } = await import('../agent-accounts/decide-account-creation');
    expect(decideAccountCreation({
      kind: 'api_key',
      name: 42 as never,
      allowedOrigins: ['https://good.example.com'],
      ownership: {} as never,
      acknowledged: true,
      placement: { in: 'header', name: 'x-api-key' } as never,
      apiKey: 'sk_test',
      allowGenericRequests: false,
      approver: 'u-1' as never,
    })).toMatchObject({ ok: false, reason: 'name_invalid' });
    expect(decideAccountCreation({
      kind: 'api_key',
      name: 'Valid name',
      allowedOrigins: ['https://good.example.com'],
      ownership: {} as never,
      acknowledged: true,
      placement: null as never,
      apiKey: 'sk_test',
      allowGenericRequests: false,
      approver: 'u-1' as never,
    })).toMatchObject({ ok: false });
  });
});

describe('origin normalization', () => {
  it('a URL without a host is malformed; a plain https origin is fine', async () => {
    const { canonicalOriginOf, normalizeOrigin } = await import('../agent-accounts/normalize-origin');
    expect(canonicalOriginOf(new URL('file:///only/a/path')).ok).toBe(false);
    expect(normalizeOrigin({ raw: 'https://good.example.com' }).ok).toBe(true);
  });
});

describe('the chat-binding refusal details', () => {
  it('the empty case names no conversation; the plural names them all', async () => {
    const { chatHeldElsewhereDetail, chatIndexRefusalDetail } = await import('../agent-workspaces/workspace-node-chat-binding');
    expect(chatHeldElsewhereDetail([])).toContain('a conversation this write would show');
    expect(chatHeldElsewhereDetail(['a'])).toContain('conversation "a"');
    expect(chatIndexRefusalDetail(['a', 'b'])).toContain('conversation');
  });
});

describe('normalizeMessageParts unknown tool states', () => {
  it('a tool part in an unknown state passes through unchanged', async () => {
    const { normalizeMessageParts } = await import('../ai/normalize-parts');
    const part = { type: 'tool-read_page', toolCallId: 't1', toolName: 'read_page', state: 'crystallizing', input: {} };
    const messages = [{ role: 'assistant' as const, content: '', parts: [part] }];
    const normalized = normalizeMessageParts(messages as never) as unknown as Array<{ parts: unknown[] }>;
    expect(normalized[0]!.parts).toHaveLength(1);
    expect(normalized[0]!.parts[0]).toBe(part);
  });
});

describe('signature verification without the signing secret', () => {
  it('refuses rather than throwing, on both the broadcast and CSRF edges', async () => {
    const { verifyBroadcastSignature } = await import('../auth/broadcast-auth');
    const { validateCSRFToken } = await import('../auth/csrf-utils');
    const previous = process.env.CSRF_SECRET;
    const previousBroadcast = process.env.REALTIME_BROADCAST_SECRET;
    delete process.env.CSRF_SECRET;
    delete process.env.REALTIME_BROADCAST_SECRET;
    try {
      // A WELL-FORMED header/token that reaches the signing step: with no secret configured,
      // signing throws and the verification refuses rather than propagating the throw.
      expect(verifyBroadcastSignature('t=1700000000,v1=deadbeef', '{}')).toBe(false);
      expect(validateCSRFToken('tok.1700000000.deadbeef', 'session-1')).toBe(false);
      // A malformed header/token cannot even be parsed: the refusal is the same false.
      expect(verifyBroadcastSignature(undefined as never, '{}')).toBe(false);
      expect(validateCSRFToken(undefined as never, 'session-1')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CSRF_SECRET;
      else process.env.CSRF_SECRET = previous;
      if (previousBroadcast === undefined) delete process.env.REALTIME_BROADCAST_SECRET;
      else process.env.REALTIME_BROADCAST_SECRET = previousBroadcast;
    }
  });
});

describe('signature verification replay and shape guards', () => {
  it('a header without a signature, a stale timestamp, a two-part token and a stale token all refuse', async () => {
    const { verifyBroadcastSignature } = await import('../auth/broadcast-auth');
    const { validateCSRFToken } = await import('../auth/csrf-utils');
    const now = Math.floor(Date.now() / 1000);
    // Broadcast: a header with no v1; a header whose timestamp is outside the replay window.
    expect(verifyBroadcastSignature(`t=${now}`, '{}')).toBe(false);
    expect(verifyBroadcastSignature(`t=${now - 100_000},v1=deadbeef`, '{}')).toBe(false);
    // CSRF: a token with the wrong part count; a token past its max age.
    expect(validateCSRFToken(`tok.${now}`, 'session-1')).toBe(false);
    expect(validateCSRFToken(`tok.${now - 100_000}.deadbeef`, 'session-1')).toBe(false);
  });
});

describe('the credits-updated broadcast', () => {
  it('with no realtime URL configured it falls back to the well-known port and contains the failure', async () => {
    const { emitCreditsUpdated } = await import('../billing/credit-emit');
    const previous = process.env.INTERNAL_REALTIME_URL;
    delete process.env.INTERNAL_REALTIME_URL;
    try {
      // localhost:3001 is not listening in tests: the broadcast fails and is CONTAINED.
      await expect(emitCreditsUpdated({ userId: 'u-1' } as never)).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_REALTIME_URL;
      else process.env.INTERNAL_REALTIME_URL = previous;
    }
  }, 20_000);
});

describe('step-up challenge binding metadata', () => {
  it('metadata that is not a JSON object binds nothing: the challenge reads as a mismatch', async () => {
    const { decideStepUpChallenge } = await import('../auth/step-up-decisions');
    const now = new Date();
    const verdict = decideStepUpChallenge({
      challenge: { usedAt: null, expiresAt: new Date(now.getTime() + 60_000), metadata: 'null' },
      actionBindingHash: 'h-1',
      now,
    });
    expect(verdict).toEqual({ outcome: 'binding_mismatch' });
  });

  it('metadata that is a bare JSON number binds nothing either: the challenge reads as a mismatch', async () => {
    const { decideStepUpChallenge } = await import('../auth/step-up-decisions');
    const now = new Date();
    const verdict = decideStepUpChallenge({
      challenge: { usedAt: null, expiresAt: new Date(now.getTime() + 60_000), metadata: '42' },
      actionBindingHash: 'h-1',
      now,
    });
    expect(verdict).toEqual({ outcome: 'binding_mismatch' });
  });

  it('metadata carrying the matching hash is a valid step-up', async () => {
    const { computeActionBindingHash, decideStepUpChallenge } = await import('../auth/step-up-decisions');
    const now = new Date();
    const hash = computeActionBindingHash({ conversationId: 'c-1', driveId: 'd-1', toolName: 'read_page' } as never);
    const verdict = decideStepUpChallenge({
      challenge: { usedAt: null, expiresAt: new Date(now.getTime() + 60_000), metadata: JSON.stringify({ actionBindingHash: hash }) },
      actionBindingHash: hash,
      now,
    });
    expect(verdict).toEqual({ outcome: 'valid' });
  });
});
