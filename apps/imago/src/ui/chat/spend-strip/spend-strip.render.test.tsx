import { describe, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConversationSpend } from '@/retained/hooks/useConversationSpend';
import { SpendStrip } from './spend-strip';
const state = vi.hoisted(() => ({ spend: null as ConversationSpend | null, personal: { billingEnabled: true, spendable: 612 } }));
vi.mock('swr', () => ({ default: () => ({ data: state.personal, mutate: vi.fn() }) }));
vi.mock('@/realtime/realtime-provider', () => ({ useSocketEvent: () => {} }));
vi.mock('@/retained/hooks/useConversationSpend', () => ({ useConversationSpend: (id: string | null) => ({ spend: id ? state.spend : null, choose: vi.fn() }), useDriveSpend: (id: string | null) => ({ spend: id ? state.spend : null }) }));
const options: ConversationSpend['options'] = [
  { source: 'drive_wallet', walletId: 'drive', label: 'Design wallet', driveName: 'Design', orgName: 'Team', remainingCents: 100, remainingCredits: '100' },
  { source: 'seat_allowance', walletId: 'seat', label: 'Your Team allowance', driveName: 'Design', orgName: 'Team', remainingCents: 50, remainingCredits: '50' },
  { source: 'own_credits', walletId: 'own', label: 'Your credits', driveName: null, orgName: null, remainingCents: 612, remainingCredits: '612' },
];
const markup = () => renderToStaticMarkup(<SpendStrip conversationId="c1" driveId="d1" isGlobal={false} />);
describe('actual conversation spend disclosure', () => {
  test.each(['drive_wallet', 'seat_allowance', 'own_credits'] as const)('names the resolved %s source', source => {
    const selected = options.find(o => o.source === source)!;
    state.spend = { conversationId: 'c1', driveId: 'd1', chosenWalletId: selected.walletId, options, resolved: { kind: 'spend', source, walletId: selected.walletId, fallbackApplied: false, fallbackFrom: null } };
    const result = markup();
    expect(result).toContain(selected.label);
    expect(result).toContain(selected.remainingCredits!);
    if (source !== 'own_credits') expect(result).not.toContain('Your credits</strong>');
  });
  test('names a refused drive source and offers a choice without claiming personal spend', () => {
    state.spend = { conversationId: 'c1', driveId: 'd1', chosenWalletId: 'drive', options, resolved: { kind: 'refuse', source: 'drive_wallet', reason: 'source_empty', options: [{ source: 'own_credits', walletId: 'own' }] } };
    expect(markup()).toContain('empty this month');
    expect(markup()).toContain('Design wallet');
    expect(markup()).not.toContain('Spending from <strong');
  });
  test('a permitted fallback names the actual replacement and why', () => {
    state.spend = { conversationId: 'c1', driveId: 'd1', chosenWalletId: 'drive', options, resolved: { kind: 'spend', source: 'seat_allowance', walletId: 'seat', fallbackApplied: true, fallbackFrom: 'drive_wallet' } };
    expect(markup()).toContain('Your Team allowance');
    expect(markup()).toContain('Design wallet cannot cover this');
  });
  test('does not invent personal funding while a scoped wallet is still loading', () => {
    state.spend = null;
    expect(markup()).toBe('');
  });
});

test('a single refused source remains visible with no personal fallback', () => {
  state.spend = { conversationId: 'c1', driveId: 'd1', chosenWalletId: 'drive', options: [options[0]], resolved: { kind: 'refuse', source: 'drive_wallet', reason: 'source_empty', options: [] } };
  expect(markup()).toContain('Design wallet');
  expect(markup()).not.toContain('Your credits');
});
test('an unscoped personal assistant preview uses only the personal balance', () => {
  expect(renderToStaticMarkup(<SpendStrip />)).toContain('Your credits');
  expect(renderToStaticMarkup(<SpendStrip />)).not.toContain('Design wallet');
});
