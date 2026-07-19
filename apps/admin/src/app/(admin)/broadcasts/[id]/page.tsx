import { PageHeader } from "@/components/admin/kit";
import { BroadcastProgress } from "@/components/admin/broadcasts/broadcast-progress";

export default async function BroadcastDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <div className="space-y-6">
      <PageHeader title="Broadcast" description="Live status, counts, and step log for this broadcast." />
      <BroadcastProgress broadcastId={id} />
    </div>
  );
}
