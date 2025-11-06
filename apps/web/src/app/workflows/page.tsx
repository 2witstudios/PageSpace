import { WorkflowsPageClient } from '@/components/workflows/WorkflowsPageClient';

export const metadata = {
  title: 'Workflows | PageSpace',
  description: 'Discover and manage workflow templates',
};

export default function WorkflowsPage() {
  return <WorkflowsPageClient />;
}
