// @vitest-environment jsdom
import '@/retained/test/setup';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const reads = vi.hoisted(() => ({ context: vi.fn(() => ({ creatorNames: { u1: 'Priya' }, walletLabel: 'Product wallet', orgName: 'Northwind' })) }));
vi.mock('@/retained/hooks/useAutomationSpendContext', () => ({ useAutomationSpendContext: reads.context }));
vi.mock('@/retained/hooks/useWorkflows', () => ({ useWorkflows: () => ({ workflows: [{ id: 'wf1', contextPageIds: ['p1'] }], isLoading: false, mutate: vi.fn(), runWorkflow: vi.fn(), toggleWorkflow: vi.fn(), deleteWorkflow: vi.fn() }) }));
vi.mock('@/retained/components/workflows/WorkflowList', () => ({ WorkflowList: ({ spendContext }: { spendContext?: { walletLabel: string } }) => <div data-testid="workflows">{spendContext?.walletLabel}</div> }));
vi.mock('@/retained/components/workflows/WorkflowForm', () => ({ WorkflowForm: () => null }));
vi.mock('@/retained/components/workflows/WorkflowStepsEditor', () => ({ synthesizeSteps: vi.fn() }));
vi.mock('@/retained/components/workflows/DeleteWorkflowDialog', () => ({ DeleteWorkflowDialog: () => null }));
import { TaskListWorkflowsDialog } from './TaskListWorkflowsDialog';
it('the task automation list names its actual drive wallet', () => {
  render(<TaskListWorkflowsDialog open onOpenChange={vi.fn()} driveId="d-org" pageId="p1" taskListTitle="Tasks" />);
  expect(screen.getByTestId('workflows').textContent).toBe('Product wallet');
  expect(reads.context).toHaveBeenCalledWith('d-org');
});
