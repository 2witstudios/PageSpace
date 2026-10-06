import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkflowList } from '../WorkflowList';
import type { Workflow } from '../types';

const workflow: Workflow = {
  id: 'wf1', driveId: 'd1', createdBy: 'u-priya', name: 'Weekly digest workflow', agentPageId: 'a1', prompt: 'p', steps: null,
  contextPageIds: [], triggerType: 'cron', cronExpression: '0 9 * * 1', timezone: 'UTC', isEnabled: true, ownerLeftAt: null,
  nextRunAt: null, lastRun: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
const noop = vi.fn();

// jsdom has no layout, so this pins the responsive contract the 390px real-app check verified: on a phone the
// row keeps the name, its status, the switch and Run in view; the schedule and run times wait for wider screens.
describe('WorkflowList on a narrow screen (review: Workflows overflowed at 390px, hiding status and Run)', () => {
  it('UI-8 (partial) the schedule, last run and next run columns are hidden below md; name, status, the switch and Run always show', () => {
    render(<WorkflowList workflows={[workflow]} onRun={noop} onToggle={noop} onEdit={noop} onDelete={noop} />);
    for (const name of ['Schedule', 'Last Run', 'Next Run']) {
      expect(screen.getByRole('columnheader', { name }).className).toContain('hidden md:table-cell');
    }
    for (const name of ['Name', 'Status', 'Enabled', 'Actions']) {
      expect(screen.getByRole('columnheader', { name }).className).not.toContain('hidden');
    }
    expect(screen.getByRole('button', { name: 'Run workflow' }).closest('td')?.className ?? '').not.toContain('hidden');
  });
});
