import { WorkflowBuilderPage } from '@/components/workflows/WorkflowBuilderPage';

export const metadata = {
  title: 'Create Workflow | PageSpace',
  description: 'Create a new workflow template',
};

export default function NewWorkflowPage() {
  return <WorkflowBuilderPage mode="create" />;
}
