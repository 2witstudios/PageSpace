import { beforeEach, describe, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConversationSpend } from '@/retained/hooks/useConversationSpend';
import { SpendStrip } from './spend-strip';
const state = vi.hoisted(() => ({ spend: null as ConversationSpend | null, error: undefined as Error | undefined }));
vi.mock('@/realtime/realtime-provider', () => ({ useSocketEvent: () => {} }));
vi.mock('@/retained/hooks/useConversationSpend', () => ({
  useConversationSpend: (id: string | null) => ({ spend: id ? state.spend : null, error: id ? state.error : undefined, choose: vi.fn(), refresh: vi.fn() }),
  useDriveSpend: (id: string | null) => ({ spend: id ? state.spend : null, error: id ? state.error : undefined, refresh: vi.fn() }),
}));
const options: ConversationSpend['options'] = [
  { source: 'drive_wallet', walletId: 'drive', label: 'Design wallet', driveName: 'Design', orgName: 'Team', remainingCents: 100, remainingCredits: '100' },
  { source: 'seat_allowance', walletId: 'seat', label: 'Your Team allowance', driveName: 'Design', orgName: 'Team', remainingCents: 50, remainingCredits: '50' },
  { source: 'own_credits', walletId: 'own', label: 'Your credits', driveName: null, orgName: null, remainingCents: 612, remainingCredits: '612' },
];
const markup = (hasMessages = false) => renderToStaticMarkup(<SpendStrip conversationId="c1" driveId="d1" isGlobal={false} hasMessages={hasMessages} />);
const spending = (source: ConversationSpend['options'][number]['source'], from = options): ConversationSpend => {
  const selected = from.find(o => o.source === source)!;
  return { conversationId: 'c1', driveId: 'd1', chosenWalletId: selected.walletId, options: from, resolved: { kind: 'spend', source, walletId: selected.walletId, fallbackApplied: false, fallbackFrom: null } };
};
const refusedDrive = (from = options): ConversationSpend => ({ conversationId: 'c1', driveId: 'd1', chosenWalletId: 'drive', options: from, resolved: { kind: 'refuse', source: 'drive_wallet', reason: 'source_empty', options: from.length > 1 ? [{ source: 'own_credits', walletId: 'own' }] : [] } });
beforeEach(() => { state.spend = null; state.error = undefined; });

describe('a choice: several sources before the first message', () => {
  test.each(['drive_wallet', 'seat_allowance', 'own_credits'] as const)('names the resolved %s source', source => {
    state.spend = spending(source);
    const selected = options.find(o => o.source === source)!;
    const result = markup();
    expect(result).toContain(selected.label);
    expect(result).toContain(selected.remainingCredits!);
    if (source !== 'own_credits') expect(result).not.toContain('Your credits</strong>');
  });
  test('a permitted fallback names the actual replacement and why', () => {
    state.spend = { conversationId: 'c1', driveId: 'd1', chosenWalletId: 'drive', options, resolved: { kind: 'spend', source: 'seat_allowance', walletId: 'seat', fallbackApplied: true, fallbackFrom: 'drive_wallet' } };
    expect(markup()).toContain('Your Team allowance');
    expect(markup()).toContain('Design wallet cannot cover this');
  });
  test('a fallback is a problem the sender must see, even mid-conversation', () => {
    state.spend = { conversationId: 'c1', driveId: 'd1', chosenWalletId: 'drive', options, resolved: { kind: 'spend', source: 'seat_allowance', walletId: 'seat', fallbackApplied: true, fallbackFrom: 'drive_wallet' } };
    const result = markup(true);
    expect(result).toContain('Your Team allowance');
    expect(result).toContain('Design wallet cannot cover this');
  });
  test('once the conversation has messages the choice is made, so the strip goes quiet', () => {
    state.spend = spending('drive_wallet');
    expect(markup(true)).toBe('');
  });
});

describe('a problem: a refused source', () => {
  test('names a refused drive source and offers a choice without claiming personal spend', () => {
    state.spend = refusedDrive();
    expect(markup()).toContain('empty this month');
    expect(markup()).toContain('Design wallet');
    expect(markup()).not.toContain('Spending from <strong');
  });
  test('a refusal still shows mid-conversation', () => {
    state.spend = refusedDrive();
    const result = markup(true);
    expect(result).toContain('aria-label="Credit source refused"');
    expect(result).toContain('Design wallet');
  });
  test('a single refused source remains visible with no personal fallback, with or without messages', () => {
    state.spend = refusedDrive([options[0]]);
    for (const hasMessages of [false, true]) {
      expect(markup(hasMessages)).toContain('Design wallet');
      expect(markup(hasMessages)).not.toContain('Your credits');
    }
  });
});

describe('drive context still resolving or failed (JOURNEYS-2)', () => {
  test('does not invent personal funding while a scoped wallet is still loading — it names the resolution instead of silence', () => {
    const result = markup();
    expect(result).toContain('Resolving who pays');
    expect(result).not.toContain('Your credits');
    expect(result).not.toContain('Design wallet');
  });
  test('a failed check pauses sending and offers the retry, even mid-conversation', () => {
    state.error = new Error('offline');
    const result = markup(true);
    expect(result).toContain('data-testid="composer-spend-strip-error"');
    expect(result).toContain('Retry check');
  });
});

describe('nothing to choose and nothing wrong', () => {
  test('a single healthy source shows nothing', () => {
    state.spend = spending('own_credits', [options[2]]);
    expect(markup()).toBe('');
    expect(markup(true)).toBe('');
  });
  test('an unscoped personal chat shows no billing line', () => {
    expect(renderToStaticMarkup(<SpendStrip />)).toBe('');
  });
});
