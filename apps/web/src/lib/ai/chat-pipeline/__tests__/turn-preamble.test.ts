import { describe, it, expect } from 'vitest';
import { driveSpend } from '@pagespace/lib/billing/spend-target';
import { COMMAND_EXECUTION_PART_TYPE, type CommandExecutionPlan } from '@/lib/ai/core/command-processor';
import { writeTurnPreamble, type PreambleWriter } from '../turn-preamble';
import { SPEND_FALLBACK_PART_TYPE, type TurnCredit } from '../turn-credit';

const skip: CommandExecutionPlan = { kind: 'skip', commandId: 'c1', label: '/standup', reason: 'not_found' };

function collect(): { writer: PreambleWriter; parts: Array<{ type: string; id?: string }> } {
  const parts: Array<{ type: string; id?: string }> = [];
  return { writer: { write: (part) => { parts.push(part); } }, parts };
}

describe('the turn preamble both chat turns write first', () => {
  it('SPEND-4 (partial) a fallback turn writes the fallback part FIRST, then one command indicator per plan in order', () => {
    const credit: TurnCredit = { spend: driveSpend('d', 'own_credits'), walletId: 'w-marcus', fallback: { from: 'drive_wallet', to: 'own_credits' } };
    const { writer, parts } = collect();

    writeTurnPreamble(writer, { messageId: 'm1', credit, commandPlans: [skip, skip] });

    expect(parts.map((p) => [p.type, p.id])).toEqual([
      [SPEND_FALLBACK_PART_TYPE, 'm1-spend-fallback'],
      [COMMAND_EXECUTION_PART_TYPE, 'm1-command-0'],
      [COMMAND_EXECUTION_PART_TYPE, 'm1-command-1'],
    ]);
  });

  it('SPEND-4 (partial) a turn that spent its chosen source writes only the command indicators', () => {
    const { writer, parts } = collect();

    writeTurnPreamble(writer, { messageId: 'm1', credit: { spend: driveSpend('d', 'drive_wallet'), walletId: 'w-d' }, commandPlans: [skip] });

    expect(parts.map((p) => p.type)).toEqual([COMMAND_EXECUTION_PART_TYPE]);
  });
});
