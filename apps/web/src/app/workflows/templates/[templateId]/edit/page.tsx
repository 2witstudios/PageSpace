import { WorkflowBuilderPage } from '@/components/workflows/WorkflowBuilderPage';

export const metadata = {
  title: 'Edit Workflow | PageSpace',
  description: 'Edit workflow template',
};

interface EditWorkflowPageProps {
  params: Promise<{ templateId: string }>;
}

export default async function EditWorkflowPage(props: EditWorkflowPageProps) {
  const { templateId } = await props.params;
  return <WorkflowBuilderPage mode="edit" templateId={templateId} />;
}
