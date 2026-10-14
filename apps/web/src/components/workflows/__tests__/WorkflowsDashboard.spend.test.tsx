// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const reads = vi.hoisted(() => ({ context: vi.fn(() => ({ creatorNames: { u1: 'Priya' }, walletLabel: 'Product wallet', orgName: 'Northwind' })) }));
vi.mock('@/hooks/useAutomationSpendContext', () => ({ useAutomationSpendContext: reads.context }));
vi.mock('@/hooks/useWorkflows', () => ({ useWorkflows: () => ({ workflows: [{ id: 'wf1', name: 'Weekly digest', createdBy: 'u1', isEnabled: true, cronExpression: null, lastRun: null }], isLoading: false, mutate: vi.fn(), runWorkflow: vi.fn(), toggleWorkflow: vi.fn(), deleteWorkflow: vi.fn() }) }));
vi.mock('@/components/workflows/WorkflowForm', () => ({ WorkflowForm: () => null }));
vi.mock('@/components/workflows/WorkflowStepsEditor', () => ({ synthesizeSteps: vi.fn() }));
vi.mock('@/components/workflows/DeleteWorkflowDialog', () => ({ DeleteWorkflowDialog: () => null }));
import { WorkflowsDashboard } from '../WorkflowsDashboard';
it('the actual workflows dashboard visibly names its creator and configured drive wallet', () => {
  render(<WorkflowsDashboard driveId="d-org" driveName="Product" />);
  const attribution = screen.getByTestId('automation-spends-as');
  expect(attribution.textContent).toContain('Created by Priya');
  expect(attribution.textContent).toContain('Product wallet');
  expect(reads.context).toHaveBeenCalledWith('d-org', 'Product');
});
