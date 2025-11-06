'use client';

import { use } from 'react';
import { useWorkflowTemplate } from '@/hooks/workflows';
import { WorkflowTemplateDetail } from '@/components/workflows/WorkflowTemplateDetail';

export default function WorkflowTemplateDetailPage(props: {
  params: Promise<{ templateId: string }>;
}) {
  const params = use(props.params);
  const { template, isLoading, isError } = useWorkflowTemplate(params.templateId);

  return (
    <WorkflowTemplateDetail
      template={template}
      isLoading={isLoading}
      isError={isError}
    />
  );
}
