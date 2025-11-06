'use client';

import { use } from 'react';
import { WorkflowExecutionView } from '@/components/workflows';

export default function WorkflowExecutionPage(props: {
  params: Promise<{ executionId: string }>;
}) {
  const params = use(props.params);

  return <WorkflowExecutionView executionId={params.executionId} />;
}
