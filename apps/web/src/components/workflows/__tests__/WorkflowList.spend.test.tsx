import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { WorkflowList } from '../WorkflowList';
import type { Workflow } from '../types';

const base: Workflow = {
  id: 'wf1',
  driveId: 'd1',
  createdBy: 'u-priya',
  name: 'Weekly digest workflow',
  agentPageId: 'a1',
  prompt: 'p',
  steps: null,
  contextPageIds: [],
  triggerType: 'cron',
  cronExpression: '0 9 * * 1',
  timezone: 'UTC',
  isEnabled: true,
  ownerLeftAt: null,
  nextRunAt: null,
  lastRun: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
const context = { creatorNames: { 'u-priya': 'Priya Nair' }, walletLabel: 'Product wallet', orgName: 'Northwind Labs' };
const noop = vi.fn();
const list = (workflows: (Workflow & { ownerLeftAt?: string | null })[], spendContext = context) =>
  render(<WorkflowList workflows={workflows} spendContext={spendContext} onRun={noop} onToggle={noop} onEdit={noop} onDelete={noop} />);

describe('WorkflowList: automation spend state', () => {
  it('SPEND-6 (partial) a workflow says it spends as its creator (D-OW-34)', () => {
    list([base]);
    const line = screen.getByTestId('automation-spends-as');
    expect(line.textContent).toContain('Created by Priya Nair');
    expect(within(line).getByText('As Priya')).toBeTruthy();
  });

  it('SPEND-6 (partial) a run skipped because its creator left shows Skipped with why, not a raw error', () => {
    list([{ ...base, lastRun: { status: 'cancelled', startedAt: '2026-09-02T00:00:00Z', endedAt: null, error: 'AI credit gate denied: source_refused (creator_departed)', durationMs: null } }]);
    const badge = screen.getByTestId('automation-skipped');
    expect(badge.textContent).toBe('Skipped');
    expect(badge.getAttribute('aria-label')).toBe('Skipped: Priya Nair is no longer in Northwind Labs, so nothing runs as them.');
    expect(screen.queryByText(/AI credit gate denied/)).toBeNull();
  });

  it('SPEND-6 (partial) an owner-left workflow is flagged and its switch is off and disabled (D-OW-36)', () => {
    list([{ ...base, ownerLeftAt: '2026-09-30T00:00:00Z' }]);
    expect(screen.getByTestId('automation-owner-left').textContent).toContain('Owner left');
    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.hasAttribute('disabled')).toBe(true);
  });

  it('SPEND-6 (partial) with organizations dark the list is exactly as before', () => {
    render(<WorkflowList workflows={[base]} onRun={noop} onToggle={noop} onEdit={noop} onDelete={noop} />);
    expect(screen.queryByTestId('automation-spends-as')).toBeNull();
    expect(screen.queryByTestId('automation-skipped')).toBeNull();
  });
});
